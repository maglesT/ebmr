# API edition: handover after A0, design for A1

- **Date:** 5 November 2026. **Plan:** `docs/build-plan/api/plan.md` (approved), `platform-fit.md` (confirmed).
- **A0 merged** (PR #111). It added:
  - one edition list: `kernel.editions()` and `kernel.edition_codes()` (kernel 1403), with the 12 edition checks
    re-created against it (site-services 1731, recipe-core 1872);
  - `EDITIONS` in the kernel and in recipe-core `flow`, kept equal to the database list by
    `apps/tablets-server/test/library/substance-edition.test.ts`, plus a written-out copy in api-contract `designer.ts`,
    checked by `packages/api-contract/test/editions.test.ts`;
  - the designer: an API family (edition `substance`) starts BLANK from a formula whose product's dosage form is "API"
    or "Intermediate";
  - `rule_table_versions`: a substance master binds the kernel table only;
  - `editions/substance/sql` (empty) runs after `tablets`.

## Rules in force (from the lead and the owner, 4 and 5 November)

- **Platform:** API lives inside product `ebmr`, in its one database; the edition is data. Migrations:
  - the `substance` namespace takes 5000–5999;
  - a shared folder takes its next free number, cleared with the lead first.
- **Process:** one PR per slice, CI green, one review, squash-merge with a trailer that names no model. The owner said
  "merge things yourself, don't wait for me". Report to the lead (session_01PybpFuUgimTwCNtTsK7cf1) after each merge.
- **Screens:** no new home tiles, menus or screens beyond what a slice needs end to end; the declutter session
  (session_01PybpFuTPpveQkfG9WFFjUQ) owns the shared home and menus. Build only on the kept path.
- **Data owned elsewhere:**
  - deviations live in the Deviations product, so link, don't store;
  - master data comes from core: an API made on site is a core product (dosageForm "API" or "Intermediate"), a
    bought-in API is a material with category 'starting', and equipment.type is free text.
- **Full chain (owner):** route from library blocks → master approval → batch → execution → packing into drums or bags,
  with labels → review → release with a CoA.
- **Lessons from A0's CI:**
  - api-contract must not import recipe-core at run time: it splits zod into its own chunk and breaks the strict CSP
    (jitless);
  - every `[ID]` test must be listed in its control file;
  - regenerate the handbook (`pnpm handbook`) after the last source edit;
  - the SQL mutation harness needs every new or replaced function in a group;
  - `platform-wiring.test.ts` and the harness test list the namespaces.
- **Disconnected routes (declutter D1, PR #116):** `packages/api-contract/src/disconnected.ts`. The namespaces in
  `DISCONNECTED` answer 410 on the platform build, so no API screen or flow may call them: capa, incidents, pqr,
  recall, genealogy, config, notifications, qpPackage, serialisation, controlled, federation, support, contractGiver,
  alarms, equipmentData, equipmentDisplays, validation, training, dashboards, changeImpact and analytics. Genealogy's
  database edges stay; only its screens and routes go. For blend and recovery traceability (A4, A5), use the batch and
  lot records, or ask the lead before relying on genealogy routes.
- **Shared bug, being fixed by the injectables session in its own recipe-core PR:** a library block's STEP_VALUE input
  (a value from an earlier step) is never resolved at run time, so the calculation is refused on the floor. An API
  block whose calculation reads an earlier step waits for that PR. Examples: yield from the charged amount, or a
  dryer's loss read from the filter's wet cake. Until then, design A1b's blocks to read in-step values, the batch size,
  formula lines or the lot assay.
- **Injectables I-1 session (session_01PybpFse8wFqE5kSz38Fh1S)** takes its edition names from `kernel.editions()`.

## A1 split

- **A1a:** shared enablement plus a server-level test that drives one API processing and packaging batch to a released
  lot through the routes.
- **A1b:** the API catalogue v1 (data) plus the screen-level E2E acceptance.

### A1a: what blocks the chain today (file:line from the A0 exploration; verify each before changing it)

1. **No packaging master for an API.**
   - `designer/from-formula.ts:86` always writes `recordKind: 'PROCESSING'`.
   - `designer/index.ts` refuses templates and packaging copies for non-tablets editions (about lines 449 and 620).
   - `packaging-copy.ts:68,124-130` copies a PACKAGING source and keeps its edition; the dosage-form fallback is
     'Tablet' (`index.ts` about 569).
   - Smallest change: allow `start: 'BLANK'` with record kind PACKAGING for a substance family. It takes the header and
     BOM of packaging materials from the formula; check what the validator needs of a PACKAGING master (packType, etc.).
     Or allow a packaging copy whose source is a substance PACKAGING master.
2. **No block completes a substance packaging record.**
   - recipe-core 0761:26 `packaging_completion_block` has only `('tablets','TB-24')`.
   - `packaging_master_problem` (0800:76-95) therefore refuses planning and issue.
   - Add a substance row naming the library pack block, `LIB-API-PACK`. A library phase's block type is `LIB-<code>`; a
     `libraryCall` never completes. The row is a recipe-core migration (next free number, cleared with the lead) or a
     substance migration that inserts a row, which is data, not a constraint change.
3. **Bulk issue needs an `H-PACK` hold point** in the processing record (0701:65-74). from-formula adds it only to the
   SKELETON (from-formula.ts:268). For substance BLANK, add the H-PACK hold point the same way (QA release for packing,
   SM 6.7.4 / 10.2.1).
4. **`site.reserve_lot` is passed a literal 'TABLETS':**
   - `quality/receipt.ts:183`;
   - the CLIs `release-path.ts:205,496` and `demo-sr-profile.ts:204`.

   Take the edition from the batch allocation. This is a tablets-server change, but tablets behaviour stays the same.
5. **Enums lack SUBSTANCE:**
   - `api-contract/src/ns/planning.ts:51`
   - `site-services/src/batch-numbers/register.ts:18`
   - `lots/commands.ts:19`
   - `apps/tablets-web/.../BatchNumbersPage.tsx:22`

   Write them out, never import across the browser boundary. Leave the installation editions (transfers, kernel 1220,
   ui-kit brand) as they are.
6. **Market guard** kernel 0330:239: a substance scope could evaluate 'tablets' keys. Make it fail closed for
   substance (kernel migration, next free number via the lead).
7. **GREL (release readiness):**
   - `recipe.grel_edition_items` (0780:91-105) puts groups 4 and 9 RED when the edition has no hook.
   - The tablets hook `tab.grel_edition_items` (tablets 1160/1162/1163) refuses unless `f.edition = 'TABLETS'`, and its
     pack items read TB-24 entries.
   - Add `substance.grel_edition_items` in `editions/substance/sql/5000_*.sql`, registered for 'SUBSTANCE'. It reuses
     the generic `tab.grel_*` helpers (recon_serial, recon_yield, held_containers, container_release, rule_sets,
     whole_batch_parents, changed_since). Its own group 4 (drum and label reconciliation, posted quantity) and group 9
     (pack examination) read the `LIB-API-PACK` entries.
   - This is the plan's first substance migration. Add it to the SQL mutation harness group, the handbook
     modules.yaml, and the namespace lists.
8. **`features/operations/erp-orders.ts:35`** filters `f.edition = 'tablets'`. Check whether a GMP batch issue needs an
   ERP production order (recipe-core 0602 gmp_issue_erp_order), or whether manual planning works without the frozen
   ERP simulator.
9. **The finished lot is posted as kind FINISHED.** That is enough for A1. C1 (the INTERMEDIATE and API lot kind) comes
   with A2, cleared with the lead first.

### A1b

- **Catalogue v1 as data**, edition `substance`, in the shape of the capsules catalogue load (PR #105). Blocks:
  API-DISP, API-CHARGE, API-REACT, API-IPC-COMPLETE, API-CRYST, API-FILTER, API-DRY (LOD loop), yield, API-PACK and
  API-LABEL-CHECK.
- **E2E acceptance:** one API master pair on screen, through to the released lot, as a new E2E group (about 30 minutes
  or more gets its own group in `playwright.config.ts` and `ci.yml`).
- **AS controls:** add AS-01 to AS-10, AS-14 to AS-16, AS-18 and AS-24 as files, with the slice's tests listed, sent
  through the lead. Then `tools/register` gets 'substance' in its editions.
- **Codes:** none new expected in A1. `ebmr.coa.sign` and `report.coa_v1` come in A3, sent to the lead.
