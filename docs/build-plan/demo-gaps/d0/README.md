# D-0 Restriction sweep (7 November 2026)

Owner rule: as much flexibility as possible within compliance; a refusal with no binding clause behind it is a defect.
Every refusal an author can hit building a master, formula, packaging master or library block, classified:
(a) a binding clause, (b) a real technical need of the engine or record integrity, (c) neither. Nothing is changed by
this sweep: (c) rows are removed or relaxed in small PRs after the lead's audit.

**Caveat.** The basis of every (a) row rests on the repository's own paraphrases (`compliance/controls/*.yaml`
`sources`, `compliance/requirements/`), not on the official texts; each is marked "per repo sources" and needs the
check against the official text before a row is relied on to keep a refusal.

| Table | Rows | (a) | (b) | (c) or partly (c) |
|---|---|---|---|---|
| [Validator rules](validator.md) (`packages/recipe-core/src/validator`) | 59 | 15 | 29 | 15 |
| [Database and server](database-and-server.md) (EBMR-FRM-*, EBMR-RCP-* and others, unique indexes, designer refusals) | 103 | 33 | 56 | 13 |
| [Library blocks](library.md) (LIB-*, EBMR-LIB-*, define-time checks) | 99 | 33 (8 also b) | 56 | 9 |

There are no EBMR-MBR-* codes; master refusals use EBMR-RCP-* (and PLN, LBL, LIB, TAB, RBE).

## The (c) rows that block real formulations (proposed first)

| # | Rule | Refuses | Proposal |
|---|---|---|---|
| 1 | EBMR-FRM-010, `formula_line unique (version_id, material_code)` | the same material on two lines (bilayer, pellets, powder + solvent, a solvent in two API stages) | drop the unique key; match the BOM to formula lines by line id, not material, in `recipe.formula_mbr_problem` (1740) and `from-formula.ts` (`materialRefs`, `copy()`). Done as D-2. |
| 2 | EBMR-FRM-011 | more than one compensating excipient; an adjusted active with no compensating excipient | drop the count and the second half (it contradicts TB-01's no-compensation mode); keep "no compensating line without an adjusted active" |
| 3 | FLOW-LEVELS (operation part) and LIB_LEVEL | a phase directly in a stage | allow it: the engine, the database and the numbering need an enclosing stage, not an operation (definition/advance keep no operation; numbering.ts already numbers steps placed directly in a stage). Keep procedure -> stage. Needs an ADR 0004 amendment, no control change. |
| 4 | EBMR-LIB-024 | a seed block of another edition in a master | mark the edition-neutral seed blocks (clearance, room check, sift, mill, dry, blend, hold, transfer, packaging) generic, so injectables and API masters can use them |
| 5 | LIB-PERFORM-SECTION | a block section recorded zero times | a section-level `required: false` (event sections: extra binder, alarm acknowledgement, rework) |
| 6 | GMP-STAGE-YIELD | a material stage with no yield; any step after the yield | allow "no intermediate yield" with a signed reason (PR-03 says intermediate yields where applicable); nothing-after-yield a warning |
| 7 | mbr_family_identity / no discard | a restart after an abandoned draft (DESIGNER_FAMILY_EXISTS) | keep the index; the lifecycle already has WITHDRAW from a draft: expose it in the designer and let a new draft start in the same family. Done as D-3. |
| 8 | EBMR-FRM-006 (formula draft) | a wrong formula draft (no withdraw, no line edit) | withdraw a DRAFT formula version with a reason and an audit record |
| 9 | EBMR-FRM-009 | a coating line per batch on a capsule, which the designer asks for (`from-formula.ts:122`) | allow it for a capsule (defect) |

The other (c) rows (limits such as 60 formula lines and 9 further batch sizes, pin-once rules, warnings that are
errors, clearance and equipment status per stage, risk reduction per item, the sources a hold time or timer may cite,
reprocessing caps, LIB-NO-FIELDS, a repeated signature meaning with different roles) are in the three tables, each with
its proposal.

## Defects found on the way

- Line ids are case-sensitive in the database but upper-cased into BOM ids: lines `mcc` and `MCC` pass and then collide.
- A duplicate formula (same product, strength and batch size) is a bare unique violation with no EBMR-FRM code.
- Citations: LIB-SIGNATURE-PERFORMED cites ST-33 (aseptic simulation); the equipment refusals cite PR-19 and IN-11;
  FLOW-LOOPS' endpoint refusal cites DI-34; GMP-SIGNIFICANT-STEPS cites PR-03/IN-02 where PR-14 fits; GMP-REPROCESSING
  cites PR-03.

## Intended, not a bug (D-4 question)

TB-04, TB-05 and TB-18 show "existing masters only": they are built-in tablet blocks, not library blocks. Decision 0026
O-6 takes TB-01..24 out of the palette (`apps/tablets-server/src/features/designer/palette.ts` `retiredFromPalette`,
`insertable: false`); existing masters keep running them. Their library replacements are PROC-RMG, PROC-FBD and the
COAT-* blocks.
