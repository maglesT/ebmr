# D-4: the demo's approved catalogue and the "existing masters only" blocks

Found:
- A fresh demo had none of the 145 seed library blocks loaded or approved, so "Add library block" (APPROVED blocks only)
  was empty until QA approved each one by hand. No demo set-up called loadCatalogue or BLOCK_APPROVE.
- The badge of TB-04, TB-05 and TB-18 ("existing masters only (library replaces it)") did not say which library block
  replaces them.

Fix (lead, 8 November 2026; option 1):
- `pnpm demo:setup` passes `--gmp-demo-catalogue`. The GMP set-up then loads the catalogue as drafts (the same
  `draftSeedCatalogue` as "Load the ready-made catalogue") and approves every block through the real signed act: the
  demo QA persona signs LIBRARY_BLOCK_APPROVED and `recipe.approve_library_block` records it
  (`apps/tablets-server/src/cli/demo-catalogue.ts`).
- The record says what was done (owner rule). Each approval's command and signature carry the reason "Demo set-up: seed
  catalogue approved by the demo QA persona (demo:setup)", through the new optional `reasonText` of the set-up's
  `signAs`. The other demo signatures (the licence, the masters) already carry the set-up's reason, "demo installation
  set-up" (reason code DEMO_SETUP).
- It is DEMO-ONLY: `demoSeedRefusal` refuses it on a database not named as a demo or E2E one, the E2E stacks do not pass
  it, and only the set-up CLI imports the module.
- The badge names the replacement: TB-04 points to the library's PROC-RMG, TB-05 to PROC-FBD, and TB-18 to the COAT-
  blocks (`palette.ts` `LIBRARY_REPLACEMENT`).

No migration. Tests:
- `apps/tablets-server/test/seed/demo-catalogue.test.ts`: every seed block of every edition is APPROVED with one QA
  signature, each audit record carries the reason, and only the CLI imports it.
- `demo-seed-gate.test.ts`: the option is refused on a non-demo database.
- `palette-tablets.test.ts`: the badges name their replacements, and each named block is in the seed.
