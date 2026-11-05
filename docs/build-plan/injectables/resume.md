# Injectables: resume notes (after I-0, 5 November 2026)

Read these instead of the session history. The rules in force are in `plan.md` (approved v2), `platform-fit.md`,
section 9 of the plan (the owner's and the lead's answers) and the hard rules of `CLAUDE.md`.

## Where it stands

- **Plan:** `plan.md` v2, approved by the owner and the lead on 4 November (PR #101).
  - There is no sterile code. Every item is met by one of: a library block of existing field types, a qualification
    record, an equipment or room due date, or the existing release gate.
  - Binding clauses only (Q0): every numbered requirement of Annex 1, Schedule M, EU GMP and 21 CFR, limit tables
    included. Guidance-only behaviours are not built (section 8a).
- **Platform** (`platform-fit.md`, ADR 0001 amendment): injectables is not a separate product or database. It lives
  inside product `ebmr` and its one database, and the edition is data.
- **I-0 merged** (PR #107, f38e23e):
  - Migration recipe-core 1871 puts the edition inside a library block's definition, so the approval hash covers it
    (`tablets` when the definition names none).
    - `recipe.library_editions()` and the constraint `library_block_edition` are the single list. The API edition
      replaces them to add `substance`.
    - EBMR-LIB-023 refuses an unknown edition. EBMR-LIB-024 refuses QA's approval of a master that holds a block of
      another edition.
  - The library list has an `edition` filter, and the designer's picker uses it.
  - `createFamily` takes an `edition`. An injectables family starts BLANK, from the formula of a product whose dosage
    form is injectable.
  - The family list shows every edition.
- **Q1 table:** `control-decisions.md` lists the proposed decisions on the 91 ST and IN controls (89 MODIFY,
  1 FOLLOW, 1 DONT_FOLLOW). It waits for the owner's single approval through the lead. Until then, build to the plan
  and edit no control file. After approval, the lead or the owner records each `expert_decision`.

## Next: I-1, terminally sterilised small-volume vials and ampoules

- **Blocks (data):** INJ-01, 02, 04, 05, 06, 12, 14, 15 (vial and ampoule formats), 18, 19, 20, 21, 22 (manual), 23,
  24, 25 and 26. The rows of plan section 4 give each block's fields and clauses.
  - The seed goes in the edition's own catalogue, with `edition: 'injectables'`.
  - The catalogue-load route today loads `TABLETS_CATALOGUE`. Add an injectables catalogue load the same way that
    Capsules C1 extended it.
- **Master data:**
  - room classes per grade;
  - qualification types GOWNING.<grade>, APS.<line> and EYESIGHT, with valid-to dates;
  - area authorisation on the A/B rooms (kernel 1190);
  - requalification as a due date on the rooms.
- **Header:** show "Batchwright Injectables" when an injectables master or batch is on screen. Reuse the Capsules C2
  mechanism (PR #109: optional `RunHeaderView.dosageForm` and a `brand.Edition` display value). The sign-in page and
  the page title stay as they are until the owner decides.
- **Sterile rule table:** the market engine must load `sterile` for injectables scopes. Today
  `apps/tablets-server/src/platform/rule-tables.ts` loads only kernel and tablets. Add it, and check `EBMR-MKT-054`
  both ways.
- **Done when:** a vial batch and an ampoule batch are built on screen and run to release in the sandbox.
- **Possible shared change** (plan section 3): a repeat that adds rows as events happen, for interventions. Needed
  only from I-2. Check first whether a step-level event or exception log already covers it.

## Rules learnt in I-0 (they cost CI rounds)

- A new SQL function goes into a group in `tools/sql-mutation/src/targets.ts`, or is left out with its reason
  (decision 0019).
- A new test tagged with a control ID is listed in that control's `tests:` (tests lists only; no other control text).
  Then run `pnpm -s handbook`, because the control map is generated.
- A new required field in an API view needs the fixtures to follow it:
  - `packages/api-contract/fixtures/*.json`;
  - the web test fixtures (`library-page`, `designer/library-blocks`).
- Run the whole web suite (`vitest --project dom`) and the register tests before pushing.
- Merge main with a merge commit, never a rebase. Other sessions (Capsules, API, Tablets) merge often, and
  `PROGRESS.md` and `from-formula.test.ts` are the usual conflicts.
- The edition list moves to one source with the API edition's A0 (lead-approved, 5 November):
  - in SQL, `kernel.editions()` (kernel 1403), with the inline edition checks re-created against it (site-services
    1731, recipe-core 1872); `recipe.library_editions()` delegates to it and adds 'generic';
  - in TypeScript, the kernel's `EDITIONS`, which `LIBRARY_EDITIONS`, the `Edition` unions and the `createFamily` enum
    derive from.

  Take every edition literal from these; never write a new inline list.
- Migration numbers: shared directories take the next free number, cleared with the lead. `inj.*` uses 3000-3999.
