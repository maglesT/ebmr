# R-flow: the flow and library rows of the D-0 sweep (plan)

Part of the demo-gap plan (`plan.md`; the sweep and the lead's decisions in `d0/README.md`, the rows in
`d0/validator.md` and `d0/library.md`). One PR. Every change works in all editions (tablets, capsules, injectables,
API); each test runs against at least one master of another edition.

When a change keeps a refusal because a binding clause asks for it, the PR quotes the official text of that clause.

## Items

1. **A phase directly in a stage** (FLOW-LEVELS part 1, LIB_LEVEL). Allow a phase, hold point or library call directly
   in a stage body. Keep procedure -> stage, no stage in a stage, and no step outside a stage (FLOW-LEVELS parts 2 and
   4, class (b)). Code: `packages/recipe-core/src/validator/rules-structure.ts` (FLOW-LEVELS, about lines 74-95), and
   `packages/recipe-core/src/flow/expand.ts` (LIB_LEVEL, about lines 131-137): an OPERATION-level library element may
   be called in a stage. Write an ADR 0004 amendment (decision 1, the ISA-88 tree: the operation level becomes
   optional; the engine, graph, numbering, stage summary and database already treat it as optional, as shown in
   `d0/validator.md`, "FLOW-LEVELS: does the engine need a phase inside an operation?"). There is no control change.
   An empty operation becomes a warning (FLOW-LEVELS part 3, operation only); an empty stage stays an error.
   Tests: the existing FLOW-LEVELS test and property.test.ts:166 change. A phase in a stage passes the full validator
   and runs (engine and SQL numbering, e.g. `2.3`). Include an injectables or API master.
2. **Generic seed blocks** (EBMR-LIB-024). Mark the edition-neutral seed blocks generic: clearance, room check, sift,
   mill, dry, blend, hold, transfer, packaging. Leave out any block that is tablet-specific, such as compression and
   coating. Code: `packages/recipe-core/src/library/seed/` (the `edition` member) and SQL 1871's LIB-024 check. A
   generic block with an unchanged body keeps its version; if the data must change, the block gets a new version, as
   the library's versioning requires. Test: an injectables master and an API master approved with a generic seed block.
3. **Optional event sections** (LIB-PERFORM-SECTION). Add `required: false` on a section only where the block marks it
   as an event or conditional section: extra binder, alarm acknowledgement, rework. A section that is the step's
   processing record stays required (211.188(b), documentation of each significant step: quote the official text).
   Code: `library/model.ts` (SectionDef), `check-definition.ts`, and `block-version.ts:632-633`.
4. **A stage with no yield, with a reason** (GMP-STAGE-YIELD, `validator/rules-content.ts`, about line 312). A stage
   may state "no yield for this stage" with a reason written on the stage. It is approved with the master, with no
   extra signature (211.103: yields at the end of each appropriate phase, and the master decides which phases are
   appropriate). "Material steps after the yield step" becomes a warning. Code: the stage model (a field such as
   `noYieldReason`), the parser, the designer's stage form, and the rule.
5. **Fieldless INSTRUCTION and SIGN_OFF blocks** (LIB-NO-FIELDS, `check-definition.ts:130, :195`). Allow a block with
   no fields when its role is INSTRUCTION or SIGN_OFF; the PERFORMED signature is the record.
6. **A target without limits** (LIB-USE-TARGET, `check-use.ts:77`). Allow a target with no limits on a slot that is
   not required; it is recorded as an instruction, with no judgement. A market rule still needs limits
   (LIB-USE-MARKET-RULE, (b)).
7. **LIB-CALC-REQUIRED becomes a warning** (`check-definition.ts:226`): `required: false` on a CALC field is ignored.
8. **Citations**:
   - LIB-SIGNATURE-PERFORMED cites ST-33; change it to PR-14 and DI-35.
   - The equipment refusals (LIB-EQUIPMENT-FACTS, -CLASS, -FITNESS) cite PR-19 and IN-11; change them to the
     equipment control (check its YAML).
   - The FLOW-LOOPS test-endpoint refusal cites DI-34; add the OOS and reprocessing control.
   - GMP-SIGNIFICANT-STEPS cites PR-03 and IN-02; change it to PR-14.
   - GMP-REPROCESSING cites PR-03; change it to PR-47 and IN-19.

   Check each new ID in `compliance/controls/` before using it.
9. **The lead's nits from #159** (D-1):
   - (a) `rules-content.ts`, about lines 419-420: give the new "no minimum and maximum" refusal a basis comment
     (PR-31 and PR-39, yield limits with their source).
   - (b) Tag `apps/tablets-server/test/designer/new-stage.test.ts`, about lines 65 and 85, with [PR-31], and list
     them in PR-31.yaml.
   - (c) The injectables, API and capsule cases in that test are dc-mini with the edition and dosage form swapped. Say
     so in the PR text, and use a real master of that edition if one exists. None existed on 7 November: test
     fixtures hold only dc-mini, tablet-granulation-compression and tablet-blister-packaging. Injectables and API
     masters start blank from a formula (see `discard-draft-editions.test.ts` for that set-up).

Not in R-flow: the sanity bounds (LIB-FIELD-DECIMALS, LIB-FIELD-LENGTH, 60 formula lines, 9 further batch sizes) stay
as (b) storage and screen limits, citing no clause. R-rest takes the other (c) rows.

## Done (PR #162) and the gap left

Built as planned; the lead's audit of #162 settled the generic set: the controls, dispensing (weight, potency, liquid),
sift, mill, cone mill, dry mix, hold, transfer, carton, label reconciliation and shipper are generic. **Gap:** PROC-FBD,
PROC-TRAY-DRY and PROC-BLEND stay tablets blocks (their text names granules; the API edition has its own drying
blocks), and PACK-CODING and PACK-LEAK stay tablets blocks (blister or strip foil, pockets). Making any of them generic
changes its data, so it is a new version with edition-neutral wording; not in this PR.
