# Slice 6a builder brief (server, contract, master data)

Branch `phase-3/slice-6a` from `phase-3/slice-6` (after 6a-0). Read CLAUDE.md, `docs/build-plan/phase-3/slice-6-plan.md`
(interfaces, ownership, ranges, defaults D-S6-1 to D-S6-10) and the slice 5a brief for the house rules (new
migrations only; create-or-replace from the latest definition; hardened definers, ADR 0012 and 0016; insert-only
tables; the person's own reason; tests as the app role with bypass attempts; tags only where proven).

Specs (search, do not read whole): outline 7 (key screens and roles), 5.2.2 (planning and issue), 5.2.9 (lots);
decision 0006 part 1; `docs/decisions/phase-2-open-questions.md` F14.3 and F14.5. Backlog: 2b (`/api/test-runs` on
GMP), 3a #7 (G-06 in client intents), 3b, 3c, 3d, 4b (entry kinds not in the contract; SSCC register route), 5b (TB-08
and G-24@2 routes, server-side source facts).

Order:
1. **6a-0 (commit alone to `phase-3/slice-6`, report the id at once):** every contract item under "Interfaces fixed
   before building" with names and paths exactly as written, each new route with an example; `TabletEntryKind` from the
   block registry with its equality test; `seed-gmp.ts` stub called from `seed.ts`. No server logic yet beyond what
   typecheck needs (routes may answer 501 until step 2).
2. Signed acts over HTTP: one signable handler per new kind (aggregate, meaning, expected state, preview content,
   dry run, apply) in `features/quality/` (quality, lot, reprocessing acts), `features/master-data/` (formula) and
   `features/plant/` (verifications); each calls the existing database command, which stays the decider.
3. GMP batch routes (`/api/batches/*`, D-S6-1) over the existing run handlers in `features/execution/`; BLOCK_ENTRY
   handed to the engine; the TB-08/G-24@2 addition-sources read; the SSCC register read.
4. Planning (`features/planning/`): open ERP orders with the matching effective MBR or the reason none matches.
5. Master data (`features/master-data/`, `features/plant/`): plant definitions over `recipe-core/src/plant` commands;
   the formulation library (D-S6-3, D-S6-4) in recipe-core 0640 onwards and `packages/recipe-core/src/formula/`;
   FORMULA.READ enforced in the database read functions and the designer's composition view; "Choose a product"
   (`/api/designer/formula-choice`) in `features/designer/` (not `templates/`, which is 6c's).

Yours: `packages/api-contract/**`, `apps/tablets-server/src/features/**` except `execution/seed*.ts`,
`features/devices/**` and `designer/templates/**`; `packages/recipe-core/src/formula/`; SQL in your ranges only. Not
yours: web, e2e, compliance yaml, simulators, gateway, integration-sdk, seeds. Need one? Report to the planner.

Tests: the 6a list in the plan, with the exact titles given there (6c maps clauses to them). Do not edit
`compliance/controls/*` (the register sync runs once on the integrated branch). Report in at most 25 lines (files,
routes, database rules, tests, defaults, open items).
