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

## A1a done (5 November 2026, after the lead's audit)

What A1a changed, against the list above:

1. **Packaging master:** no new designer start (the audit removed PACKAGING_BLANK as outside C1-C5). An API packaging
   master is made with the existing starts. The chain test builds its masters as content. Open for A1b: how the
   on-screen E2E makes the API packaging master with the existing starts (PACKAGING_COPY copies only a packaging master).
   An ERP order needs a BOM, so the master needs at least its drum or bag line.
2. **Completion block:** recipe-core 1873 widens the `block_type` check to `LIB-<code>`; substance 5000 inserts
   `('substance', 'LIB-API-PACK')`.
3. **H-PACK:** the blank API processing master ends with a stage `S-RELEASE` holding H-PACK.
4. **reserve_lot:** the edition comes from the batch's register allocation (receipt route and the two demo CLIs).
5. **Enums:** SUBSTANCE in planning.ts, register.ts, lots/commands.ts and BatchNumbersPage.
6. **Market guard:** kernel 1404 refuses any non-kernel key on a substance scope (EBMR-MKT-054).
7. **G-REL:** `substance.grel_edition_items` (5000) returns the existing tablets items that fit any packaging order
   (printed materials G-21, yields, containers, rule sets, reprocessing parents) plus E.PACK_EXAMINATION (group 9: every
   API-PACK step completed). The core gate requires an edition item in group 9 (recipe-core 0781).
8. **ERP orders:** a GMP issue needs an ERP order through the ERP import (any edition). The DEMO-ONLY "Send a
   production order" offers tablets masters only.

**API-PACK** (`packages/recipe-core/src/library/seed/substance.ts`): one `container` section per drum or bag, with a
CONTAINER REGISTER field, the net mass, and the closure and label checks. Labels are issued and reconciled by G-21, and
the label specimen in the record (SM 9.3.7, AS-14) comes with A1b. It is not in `SEED_GROUPS` yet.

**The chain test** `apps/tablets-server/test/substance/api-chain.test.ts` drives the masters (built as content, without
the G-10/G-09 plant steps or a G-21 step) to a RELEASED lot through the routes.

## A2 part 1 (5 November 2026, paused by the owner)

- **site-services 1732:** `site.intermediate_lot`, a sibling register of `site.finished_lot` (edition SUBSTANCE only), and
  `site.create_intermediate_lot(jsonb)` (no grant to the app; a complete PROCESSING batch whose family edition is
  `substance` only, read from the batch record at run time and failing closed). Release, G-REL and every finished-lot read
  are unchanged.
- **substance 5001:** `substance.post_intermediate_lot(batch, quantity, unit)` (MATERIAL.HANDLE; expiry from
  `recipe.batch_expiry`), route `specifications.postIntermediateLot`.
- **Release:** QA's existing release for further processing (lot machine `RELEASE_FOR_FURTHER_PROCESSING`,
  MATERIAL_LOT_STATUS_DECIDED); the contract now lets `proposeLotDecision` and `LOT_DECISION` name that existing event
  (lead, 6 November: kept; no database change).
- **Test:** `apps/tablets-server/test/substance/intermediate-lots.test.ts` (A posted, released, refused while in quarantine,
  reserved by B; B posted).
- **Next:** done in A2 part 2 below.

## A2 part 2 (6 November 2026)

- **No database change.** Steps B and C consume their input intermediate through a **G-07 dispensing step** of their own
  master (BOM line = the previous intermediate): the dispenser keys the weight on a booked, qualified balance and the
  server consumes the net from the batch's reservation in the same command (tablets 1093, as tb-01-gmp.test.ts). Batch C
  then runs to a packed, released API lot as in A1a.
- **Test:** `intermediate-lots.test.ts` now runs A -> B -> C: the consumption rows and G-07 entries name each lot and
  quantity, a quarantined intermediate B is refused at the reservation and at C's weighing, and the genealogy route shows
  each step's consumption edge both ways. Shared helpers moved to `apps/tablets-server/test/substance/support.ts`
  (`api-chain.test.ts` uses them too).
- **Open for the lead (each needs a migration number):**
  1. The genealogy has no edge from a batch to its intermediate lot (`recipe.genealogy_step` reads `site.finished_lot`,
     not `site.intermediate_lot`), so one trace does not cross from lot B back to batch B: the API lot traces back to
     lot B and stops. The plan (2.3) and ICH Q7 6.52 / Revised Schedule M Part XII (batch record names the batch numbers
     of the intermediates used; traceability from the API back through its intermediates) need it.
     **Done (recipe-core 1876):** the trace now crosses intermediate lots both ways (batch -> intermediate lot edge, kind
     OUTPUT, the batch's output; not FINISHED); the last test of `intermediate-lots.test.ts` traces the API lot back to lot A and lot A forward to it.
  2. A GMP weighing (G-07 or TB-01) that consumes the **whole** remaining quantity of a lot is refused (EBMR-EXE-078):
     the lot is CONSUMED when the entry guard (tablets 1700, `tab.entry_identifier_problem`) re-reads its facts, so the
     entry's RELEASED no longer matches. The test dispenses 50 of 52 kg and 42.5 of 44 kg to stay clear of it.
