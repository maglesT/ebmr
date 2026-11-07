# Demo gaps from the bilayer tablet (MGL-SR-BL), 7 November 2026

A demo user built a bilayer tablet (metformin 500 SR + glimepiride 2 mg) on the standalone demo (be637a7) and met the
gaps below. Almost all are general: any new formulation would meet them. One small PR per item, in this order; each
item's section is written before its PR. Owner rule: different formulations must not hit coding gaps.

## D-1 A new stage passes the checks (blocking)

Found: `newStage` (designer, "Add a stage") put the stage's room clearance (G-10) and equipment status (G-09) phases
directly in the stage's sequence. The validator refuses that (FLOW-LEVELS, DI-34: a phase belongs in an operation), and
no screen adds an operation, so no new stage could pass.

Fix:
- `newStage` makes one operation, "<stage>: preparation" (`O-<slug>-PREP`, as the templates name it), holding the two
  phases. The author inserts the stage's own steps after them in that operation (the insert dialog already places a
  step inside an operation).
- Each stage its own yield (GMP-STAGE-YIELD, PR-31): a new stage takes the library yield block (CTRL-YIELD). It did
  not pass either, for two general reasons, both fixed in recipe-core:
  - `libraryPhase` listed every input of a library block as a value the master reads; a formula-line or batch-size
    input is read from the master's own BOM and batch size when the step runs (`scaledInputs`), so the validator
    reported "reads theoretical, which is not a declared value". Those two input kinds are no longer master reads.
  - GMP-YIELDS asked every yield step to name a master yield checkpoint. A library yield block computes its yield in
    a critical calculated field with a limit slot, and the step carries that limit, so it stands as its own
    checkpoint. The rule still refuses one whose limit has no minimum and maximum (PR-31, PR-39); the built-in yield
    blocks still need their checkpoint.
- "Add operation": not added. The validator accepts any number of steps in one operation, every library-built master
  so far runs with one operation per stage, and the copies keep the operations they had. Add it only when a real
  master needs two operations in a new stage.
- Both are design-time rules of the master's content, held by the validator gate the server applies
  (`combinedGate`); no database change.

Test: `apps/tablets-server/test/designer/new-stage.test.ts` (the dc-mini template passes; a new stage passes FLOW-LEVELS
and fails only GMP-STAGE-YIELD; its library yield step without limits fails GMP-YIELDS; with the product's limits the
master passes the full validator against the real adapters).

## D-2 to D-8

Sections follow, one per PR (D-2 the same material on several layers or parts and the formula form's refusal message;
D-3 discard a never-approved draft; D-4 the demo's approved catalogue and the "existing masters only" blocks; D-5 the
copied master's names; D-6 equipment class from the plant's classes; D-7 the findings panel at 1400 px; D-8 a plan only).
