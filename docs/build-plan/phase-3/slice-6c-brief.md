# Slice 6c builder brief (GB-T-01, demo seeds and devices, the Phase 3 trace gate)

Branch `phase-3/slice-6c` from `phase-3/slice-6` after the 6a-0 commit. Read CLAUDE.md, `docs/build-plan/phase-3/slice-6-plan.md`
(gate findings, ranges, ownership, D-S6-5 to D-S6-10), REPO-GUIDE.md "Traceability", the `postgres-oracle` and
`local-ci` skills. Specs (search, do not read whole): outline 9.1 "Golden batches", 11 (Phase 3 exit),
`docs/design/sample-bmr-analysis.md`, critique-logic L-28 and L-39, the TB and G block sections of
`docs/design/tablets-edition-process-and-blocks.md`. Existing pattern: `apps/tablets-server/test/execution/golden.test.ts`.

Order:
1. **Trace clauses (no dependency):** for IN-13, IN-15, IN-17, IN-21 to IN-26, IN-34 to IN-39 and PR-41 split the
   catalog test word for word into `clauses`, each naming listed passing tests or deferred to phase 4+ with a reason
   (e.g. IN-17's "release is blocked" and IN-39's notification part if not built). For the six deferrals to phase 3
   (DI-04 cl. 2, DI-13 cl. 3, DI-24 cl. 1, DI-33 scope, IN-02 cl. 1, PR-01 cl. 2) map the tests named in the plan or
   build them (step 4). Never touch `expert_decision`; follow D-S6-10 for any re-deferral. Re-run the IN-18 test first.
2. **Devices and simulators (D-S6-8):** integration-sdk process kinds per the plan list; simulators for granulator, FBD,
   blender, roller compactor and the packaging lines; instruments (moisture analyser, hardness, friability,
   disintegration, leak tester, checkweigher) on the scale protocol; the gateway's device configuration accepts them;
   `tools/demo` writes a demo gateway configuration with a press, coater, printer and packaging devices; device-kind SQL
   in tablets 1060 onwards (`tab.bind_step_device` and the 0820 reading checks are yours).
3. **Demo seeds:** `seed-gmp.ts`: GMP personas incl. a gateway identity and a verifier (backlog 3b), the ERP simulator
   catalogue, lots received, tested (LIMS-lite, second-person approval) and released; plant units, tooling, detectors.
   `seed-gb-t-01.ts`: GB-T-01's formula (invented, decision 0006 part 3), MBR and lots, including a case 2 residue lot.
4. **Gap tests and backlog:** PR-01 cl. 2 in `recipe.prepare_gmp_issue` (recipe-core 0670 onwards); DI-04 cl. 2 (tag an
   existing RECIPE_CHECK mismatch test if it proves it, else add one); TB20-NO-PLAN through a linked deviation-lite
   record (change path, backlog 5b/3d #3); 3d #4 printer-before-PRINT_SETUP verified by a test; the 3d G-23
   destruction rule on a real GMP state (in GB-T-01).
5. **GB-T-01 (after 6a's routes are on `phase-3/slice-6`):** template `features/designer/templates/gb-t-01.mbr.json`
   (+ one line in `templates/index.ts`); `apps/tablets-server/test/golden/gb-t-01/expected.json` with quantities and
   yields computed by hand first (D-S6-7) and a `README` worksheet; `gb-t-01.test.ts` running the happy and the
   exception-rich variants over HTTP (`/api/batches/*`, BLOCK_ENTRY, the ceremony, simulators reading database time)
   to the "release for packing" gate, then comparing every expected output exactly; the 9.1 sample-data negatives.
   Time per D-S6-6 (libfaketime offset file; a `golden` CI job with its own cluster). Tag each assertion block with the
   controls it proves (INV-12 to 15, 24, 31 to 33, 41 where proven).
6. **Gate:** after 6a and 6b are merged into `phase-3/slice-6`: `phase.yaml` to 3, the register sync, `pnpm run ci` and
   `pnpm trace:e2e` green.

Yours: `compliance/**`, `execution/seed*.ts`, `features/devices/**`, `designer/templates/**`, `test/golden/**`, new gap
test files, `packages/integration-sdk/src/process/**`, `apps/simulators/**`, `apps/site-gateway/**`, `tools/demo/**`, the
CI golden job, SQL in your ranges. Not yours: contract, other server features, web, e2e specs.

Report in at most 25 lines: clauses mapped and deferred (with reasons), gap tests, devices, seeds, GB-T-01 result and
normalised hash, CI time of the golden job, open items for the owner.
