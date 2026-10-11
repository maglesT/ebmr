# Slice 6b builder brief (screens)

Branch `phase-3/slice-6b` from `phase-3/slice-6` after the 6a-0 commit. Read CLAUDE.md, `docs/build-plan/phase-3/slice-6-plan.md`
(interfaces, web feature names, defaults) and `apps/tablets-web/src/app/features.ts`, the floor feature's renderer
registry and one existing renderer before writing. Build against the contract and its examples (fixture fetch); the
6a routes arrive on `phase-3/slice-6` while you work. Specs: outline 7 (users and key screens; search it),
`docs/design/features-ux-roles-configuration.md` (search per screen), decision 0006 ("Choose a product").

Scope:
1. **Shop floor (`features/floor/`):** renderers for TB-01..TB-24, G-06@1 (process values, setpoints, alarms), G-21
   (printed materials, coding, challenges, reconciliation) and G-24@2 (addition sources from the addition-sources route);
   schema-driven forms per `BLOCK_ENTRY` kind with block-specific layout (D-S6-2); the floor calls `/api/batches/*` on GMP
   and `/api/test-runs/*` on the sandbox (one switch by installation). The registry test lists no tablet block, G-06,
   G-21 or G-24@2 on the fallback. Entry actions offer void with a reason and correction, never delete.
2. **Planning (`features/planning/`):** open ERP orders, plan a batch from an order, issue with the GMP_BATCH_ISSUE
   ceremony, batch list with states.
3. **Master data (`features/master-data/`):** formulas (draft, version, approve with the ceremony), the composition view
   (hidden without FORMULA.READ, with the refusal text), ERP products and materials read-only, plant definitions
   (areas, classes, equipment, tooling, detectors, test pieces, utilities); "Choose a product" in the designer's create
   flow (`features/designer/`), filling the BOM from the approved formula.
4. **Plant (`features/plant/`):** cleaning start, complete and verify; clearance; equipment events.
5. **Quality (`features/quality/`):** deviation list and record (raise, link, investigate, finding, conclude, close,
   cancel), LIMS lot results (record, approve, OOS link, retest), lot receive, release and reject, QC extra-testing
   decision, ERP import status; reprocessing authorisations and residue reservation.

Yours: `apps/tablets-web/**`, new folders `tools/e2e/specs/{floor-tablets,planning,master-data,plant,quality}/` and any
e2e fixture additions in new files. Not yours: the contract (ask 6a), the server, existing e2e specs, compliance yaml.

Tests: component tests per page (refusals shown with the server's text, ceremony steps, role-hidden actions); the
registry test; e2e with the exact titles in the plan (`[DI-24] ... @kiosk`, `[DI-13] ... @office`) and the four flows
listed there. Tags only where the test proves the control. Report in at most 25 lines (screens, routes used, tests,
gaps in the contract you found).
