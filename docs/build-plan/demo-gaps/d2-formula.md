# D-2 Formula lines for multi-part products (with the D-0 formula rows)

Part of the demo-gap plan (`plan.md`; lead audit of the D-0 sweep in `d0/README.md`). One PR: recipe-core 1876.

Found: a material could be on one line of a formula only (EBMR-FRM-010, unique key version + material). A bilayer
tablet (the same excipient in both layers), core + coat, two kinds of granules or pellets, an injectable's powder and
solvent kit or water used twice, and an API's solvent in two stages all need it on several lines. The rule cited only
internal decision D-S6-3; 21 CFR 211.186(b) asks for a complete list of components with their quantities, not one line
per material.

Changes:
- The unique key (version, material) is dropped. No "part" or "layer" field is added: each line keeps its own line id
  (`lac`, `lac2`; `BOM-LAC`, `BOM-LAC2` in the master), which is all the master, the dispensing and the reconciliation
  key on. Line ids stay unique per version, now whatever their letter case (EBMR-FRM-023; `mcc` and `MCC` used to pass
  and then collide as `BOM-MCC`).
- The master's BOM is matched to the formula by line id (`BOM-<line id>`), or by material when the material is on one
  line only (copies keep the source's BOM ids); each formula line is matched once (`recipe.formula_mbr_problem`). The
  designer gives each formula line its own BOM line and lists a material's reference once (`from-formula.ts`).
- EBMR-FRM-011: no count of compensating excipients and no compensating excipient required for an adjusted active
  (TB-01 dispenses one without compensation); a compensating excipient still needs an adjusted active.
- EBMR-FRM-009: a capsule's coat (COATING) is given per batch, as the designer asks for it.
- A second formula for the same product, strength and batch size is EBMR-FRM-021 (it was a bare 500).
- Withdraw a DRAFT formula version with a reason (route `masterData.withdrawFormulaVersion`, button on the formula
  page). Nothing is deleted: the version, its lines and the withdrawal row stay, insert-only and in the audit trail
  (DI-24, DI-22); the version reads WITHDRAWN, is never approved (EBMR-FRM-022), and a new version may follow it. An
  approved version is not withdrawn.

"The formula screen saved silently on the 422": not reproduced. The server answers the refusal as a 422 with its code
and reason (EBMR-FRM-010 and its text), and the form shows it under the button (screen test "a new version is written per
unit ... a refusal is shown with the server's words"; a bare 500 was the duplicate formula, fixed above). The demo's
case is gone with EBMR-FRM-010 itself; if the demo user still sees no message, the lead is asked for the screen and
the step.

Tests (all editions): `apps/tablets-server/test/master-data/formula.test.ts` (describe "demo finding D-2 and the D-0
sweep"), `apps/tablets-server/test/designer/from-formula.test.ts` (a bilayer tablet master from the skeleton passes
the validator; an injectables and an API master start blank from formulas with water and a solvent on two lines; each
pinned), `apps/tablets-web/test/office/master-data.test.tsx` (the withdraw button), `packages/recipe-core/test/mutation/formulas.test.ts`.
