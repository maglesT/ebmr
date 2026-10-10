# Phase 3 slice 2b: batch execution on the GMP installation

Plan written 10 October 2026 before building. Depth follows decisions 0008 and 0009. Source: D-S2-1 (slice 2 plan),
DI-05, outline 5.2.1 and 5.2.2, the existing GMP-style issue path for stub batches (recipe-core 0170).

## Scope

1. **GMP issue.** A GMP batch is issued only from an effective MBR version: the existing stub-batch path (0170:
   version selection per market, INV-28 India in every market set, PR-04, authorisation cells with approved size,
   `batch_mbr_pin` INV-01, `control_recipe` snapshot and hash INV-02) becomes the source of a GMP
   `recipe.batch_execution`. The batch number is allocated from the site register (`site.allocate_batch_number`) in the
   same transaction and linked to the execution; issue needs BATCH.ISSUE and a signature with the meaning ISSUED.
   `batch_execution` links either a test package (sandbox) or a control recipe (GMP), never both (a check constraint).
2. **GMP writers.** `recipe.execution_actor` becomes installation-aware: on GMP it requires the validated actor and
   refuses administrators exactly as now, without the sandbox assert; on the sandbox it stays as it is.
   `recipe.execution_violations()` stops reporting GMP batches in a GMP database and keeps reporting test packages and
   SANDBOX_ONLY blocks there.
3. **Tablets server.** The execution feature is offered on both installations; the installation comes from the server
   configuration (runs, identifier checks); the NOT-GMP watermark comes from the installation (none on GMP); the
   material lookup uses `site.material_lot` on GMP and `tab.sandbox_lot` in the sandbox.
4. **DI-05 boundary kept.** Test packages are still refused on GMP; a sandbox record never becomes a GMP record; TEST-
   identifiers stay sandbox-only and real ones GMP-only (unchanged guards); SANDBOX_ONLY blocks stay refused on GMP by
   the engine and the database. The F12 identifier rule stays frozen (0008 2.1).

## Controls touched and their class

| Control / invariant | Part | Class |
|---|---|---|
| DI-05, INV-18 | sandbox boundary unchanged; GMP records only from an effective MBR | Core |
| INV-01, INV-02, INV-28, PR-04 | one pin per batch, control recipe snapshot and hash, India in every market set | Core |
| IN-18 / batch-number register | number from the register, unique, never reused, linked to the batch | Core |
| DI-17, DI-18 | GMP writers refuse administrators and check permissions | Core |
| Watermark, screens | | Other |

## Defaults taken (decision 0004)

- **D-S2b-1** The BOM match at issue waits for the ERP stub (slice 5); the authorisation cells (site, line, size,
  market) are checked now.
- **D-S2b-2** G-09 and G-10 version 2, read from the plant schema of slice 1, are tablet-block work (slice 3); until
  then a GMP MBR cannot use G-09 or G-10 (version 1 stays SANDBOX_ONLY).
- **D-S2b-3** Tests that asserted "a GMP database refuses execution" become tests of the GMP path and of the boundary
  that remains (test packages refused on GMP, sandbox records never in GMP).

## Work split

- A: database (recipe-core 0500 to 0519): GMP issue, actor, violations, links, tests.
- B (after A): tablets server (feature on both installations, configuration, watermark, lot source, routes, tests).
- Then: one quick review, register sync, full suite, PR, merge on green.
