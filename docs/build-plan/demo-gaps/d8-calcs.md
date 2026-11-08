# D-8: the author's own calculations, names and yield

Owner's items 13 and 21 from the MGL-SR-BL report, at the smallest size the owner asked for: edit a calculation's name and
expression, pick the yield calculation, and set its limits with their source. There is no new formula engine. The
validator, the simulation and approval judge the result as they judge any other content.

## What the designer can do today

The calculations, yield checkpoints and parameters of a copied or skeleton master are read-only, apart from the limit
bounds on an existing range (SET_LIMIT_BOUND and SET_LIMIT_INCLUSIVE, for the owners parameter, calculation and yield).
The author cannot:
- rename the skeleton's "Final blend", "Blend yield / Materials charged to the blender" or "Final blend discharged"
  (item 13);
- change which calculation a stage's yield uses (item 21);
- name the source of a limit; the skeleton's 98.0-100.5 % keeps the source it was copied with (item 21).

## The change (web designer ops plus their fields; no migration, no recipe-core rule change)

1. **UPDATE_CALCULATION** `{ id, name?, expression? }`. The name passes `checkName`. The expression is stored as typed:
   DATA-EXPRESSIONS and the simulation judge it against the declared inputs, as for content saved any other way.
   Shown as two text fields on the calculation's row (section 9).
2. **UPDATE_PARAMETER_NAME** `{ id, name }`, for the copied names of item 13 (D-5 renames on copy; this covers a later
   edit).
3. **UPDATE_YIELD** `{ id, name?, result?, theoretical? }`:
   - `result` is a DECIMAL calculation of the master. The steps that evaluate the checkpoint (`yieldCheckpoint === id`)
     get `computes` with the old result swapped for the new one, so GMP-YIELDS ("the step computes its result") still
     holds.
   - `theoretical` is any calculation, parameter or input id.
   - Both are offered as choices, not as free text.
4. **SET_LIMIT_SOURCE** `{ owner, id, tier, source: { kind, ref }, reference }`: the range's source, with its reference
   pinned from the effective documents (as ADD_STAGE_EQUIPMENT pins a class). The kinds are those of
   `LIMIT_SOURCE_KINDS`. GMP-LIMIT-SOURCES and the A9 warnings judge the kind against the reference. Shown beside each
   limit range in sections 9 and 10.
5. **ADD_LIMIT_RANGE** `{ owner, id, tier }`, only when the item has no range of that tier, so a yield without limits
   can get one. The bounds are then set with the existing SET_LIMIT_BOUND.

## Checks before building (no assumption)

- That the database derives nothing from an MBR calculation's expression. Library expressions are only compared in
  recipe-core 1862. The stage summary and yield rows read values the engine computed. If some SQL re-evaluates an
  expression, the edit stays, and the case goes to the lead.
- That the copy-from-formula path (from-formula.ts) keeps the yield's evaluating step and checkpoint in step after
  UPDATE_YIELD.

## Tests (tagged)

- Web op tests for each op: the change, each refusal leaving the content unchanged, and undo and redo.
  - [PR-03][PR-31] UPDATE_YIELD moves the evaluating step's computes.
  - [PR-08] SET_LIMIT_SOURCE pins the reference.
- recipe-core: a master whose yield uses an author's own calculation, with limits and a validation-report source, in
  tablets, injectables and API. It passes the validator, the engine computes the yield, and an out-of-limit yield raises
  the limit exception. [PR-31][INV-34][PR-08]
- Server: the edited content saves and is approved (GMP, QA signature). [PR-03][DI-35]
- E2E: none new. The ops are covered at unit and server level, and route-d stays green.

## Not in D-8

- A formula editor, new functions, units arithmetic beyond @ebmr/expr, and library-element calculations.
- Renaming ids. Ids stay as copied; only the names change.

## Lead's approval (8 November 2026), with conditions

1. All five ops work on a DRAFT master only; an approved or effective master changes through a new version, as
   today. Test: each op is refused on an approved master.
2. The limit source is a recorded reference, not a gate. The reason it is recorded is 21 CFR 211.160(b) (scientifically
   sound specifications), to be checked against the official text. An empty source is a validator warning, not an
   error, unless the slot is a CPP or an IPC, which already needs limits.
3. An UPDATE_CALCULATION that breaks an expression a yield or limit reads is caught by the validator at save, with its
   existing code. No new refusal.
4. This plan ships in the D-8 PR as `docs/build-plan/demo-gaps/d8-calcs.md`.

## Built (8 November 2026)

- The five ops are in `apps/tablets-web/src/features/designer/model/ops.ts`, with their fields in the document view:
  name and formula on each calculation, a name on each parameter, a name and the result and theoretical choices on
  each yield. Each limit range gets a source choice (`LimitSource.tsx`), and an item with no limits gets "Add limits".
- The checks before building:
  - No SQL evaluates an MBR calculation's expression. The SQL that reads `calculations` (0130, 0305, 1050, 1062,
    1115) never reads the expression.
  - UPDATE_YIELD swaps the evaluating step's `computes`, so the copy-from-formula master's yield step stays in step.
- Condition 2: every limit range carries a source in the model, and the parser refuses one without it. So an empty
  source cannot occur, and ADD_LIMIT_RANGE takes its source when it creates the range. 21 CFR 211.160(b) was checked
  in the eCFR text: "scientifically sound and appropriate specifications".
- Tests:
  - `apps/tablets-web/test/designer/d8-ops.test.ts`: the ops, their refusals, and undo.
  - `packages/recipe-core/test/validator/own-yield.test.ts`: three editions; the engine's YIELD_OUT_OF_LIMITS outside
    the author's limits; a broken formula caught by the existing DATA check.
  - `apps/tablets-server/test/designer/own-calcs.test.ts`: approved by QA; each op's change refused on the approved
    version with EBMR-RCP-021.
