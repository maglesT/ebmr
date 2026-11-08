# R-rest: the other (c) rows of the D-0 sweep

Part of the demo-gap plan (`plan.md`; the rows in `d0/validator.md`, `d0/database-and-server.md`, `d0/library.md`; the
lead's decisions in `d0/README.md`). R-flow (#162) took the flow and library rows; D-2 and D-3 took FRM-010, FRM-011,
the formula draft withdrawal, the family restart and the three defects. Kept by the lead as (b) storage and screen
limits, citing no clause: LIB-FIELD-DECIMALS, LIB-FIELD-LENGTH, 60 formula lines, 9 further batch sizes. Kept as an
owner decision: D8 DESIGNER_FORMULA_REQUIRED (decision 0006).

Every change works in all editions and is tested against another edition's master; where a refusal stays for a binding
clause, the PR quotes the official text.

Proposed as two PRs, because part B needs SQL and migration numbers and part A does not.

## Part A: validator rows (`packages/recipe-core/src/validator`, no migration)

1. **FLOW-CONSTRUCTS**: a parallel with fewer than two branches becomes a warning (it runs as a sequence).
2. **DATA-GUARDS (dead branch)**: a branch whose condition can never be true becomes a warning.
3. **DATA-PARALLEL (shared BOM line)**: first check whether the engine and the database count a BOM line consumed in
   two parallel branches correctly. If they do, allow it; if not, keep the refusal as (b) with the reason in the code.
4. **GMP-TYPED-FIELDS (critical TEXT)**: allow a critical text parameter when it has a pattern or an expected value;
   the DI-30 accuracy check still applies.
5. **GMP-SIGNIFICANT-STEPS (clearance second person)**: ask for a second person on a line clearance only where a
   binding clause asks for one (to be checked against the official text: packaging line clearance, Schedule M and EU
   Annex 9 or Ch. 5); otherwise one person.
6. **GMP-STAGE-CLEARANCE (per stage)**: a stage may name the earlier stage whose clearance it continues (same room or
   line, no other product in between); otherwise each bound stage starts with its clearance (EU 4.18(c), kept).
7. **GMP-EQUIPMENT-STATUS (per stage)**: a status check earlier in the same room or line, with nothing in between that
   changes the equipment's status, counts.
8. **GMP-BOM-CONSUMED (every path)**: a BOM line bound to a variant value or a branch is checked on those paths only.
9. **GMP-INTERMEDIATES and GMP-TIMERS (source kind)**: also accept a PROCESS_DATA or DOCUMENT (SOP) source, with a
   warning that asks for the written basis.
10. **GMP-REPROCESSING**: keep the declared case (a); the caps become "at least one bound plus a reference to the
    authorised procedure"; a re-treatment outside a loop becomes a warning.
11. **GMP-RISK (non-critical as a reduction)**: keep, unless the lead decides that an MBR-level criticality
    assessment may stand as the rationale.

## Part B: formula, pin and library rows (SQL; migration numbers from the lead)

1. **F30 FRM-051 target once**: the target may be set again while the formula version is DRAFT; the latest row stands.
2. **P2 FRM-018 pin once**: a DRAFT master may be re-pinned; the latest pin stands (FRM-020 checks again at approval).
3. **F36 FRM-016 (mild)**: a DRAFT formula may be pinned; approval checks it again.
4. **K4 packaging completion in a library element**: read the library snapshot instead of refusing it unread, and report
   the problem at save, not only at planning.
5. **D12 DESIGNER_COPY_NOT_APPROVED (mild)**: copy any version the author can read, the source recorded.
6. **Library #40 (repeated signature meaning)**: allow a meaning twice when the roles differ (e.g. supervisor and IPQA).

## Lead's decisions (7 November 2026)

- Split: Part A (no migration) first, Part B second. Part B takes recipe-core 1880 (ask for a second number).
- A11 GMP-RISK: accept an MBR-level criticality assessment, stated on the master and approved with it (ICH Q9 asks
  for no per-item reduction): one text field, or a reference to the risk document, on the master header.
- Re-set rules (B1, B2): insert-only, the latest row stands, earlier rows kept and shown in the history.
- A5 clearance second person: quote the clause for every case kept (211.130(e) asks for the inspection and its
  record, not a second person); check EU Annex 15 and Schedule M for verifier wording before removing.
- A3 DATA-PARALLEL: relax only after the engine and database check proves a shared BOM line is counted once.

## Later items from the owner's MGL-SR-BL report (lead, 7 November)

- Item 13 (skeleton wording kept in product use: "Final blend" after coating, "Blend yield / Materials charged to the
  blender", blendNet "Final blend discharged"): fold into D-5 (copy renaming) and D-8 (the author's own calcs and names).
- Item 21 (the skeleton's 98.0-100.5 % yield limit kept for a stage from granulation to coating; the designer cannot
  change which calculation a yield uses): D-8 lets the author pick the yield calculation and set its limits with their
  source.
- Run-time gaps (TB-07 breach, deviation link when disconnected, planned batches, 500s) go to a separate session.

## Owner's instruction (via the lead, 7 November): "go for the easiest ways to get through it"

For R-rest and D-4 to D-8: the simplest fix that unblocks real use; bundle small items to save CI runs. D-8: the
smallest version first (edit a calculation's name and expression, pick the yield calculation, set its limits with their
source); no new formula engine.

## Part A research notes (8 November)

- A5: 211.188(b)(11) (eCFR, checked): "Identification of the persons performing and directly supervising or checking
  each significant step in the operation". 211.130(e): "Inspection of the packaging and labeling facilities immediately
  before use" ... results documented in the batch record (no second person). So a second person on a clearance follows
  only from the block marking the clearance significant; the S24 reduction is the existing way to one person. Simplest:
  a clearance is a second-person step only when its block is significant; otherwise one person (no reduction needed).
- A3 DATA-PARALLEL: since D-2, portions of one material are two formula lines, so two BOM lines; keep the shared
  BOM-line refusal as (b) unless the engine check is done (simplest path).

## Part A: what was done (8 November)

All in `packages/recipe-core/src/validator`, plus two optional keys and their designer fields; no migration. Each change is
tested in the tablets, injectables and API editions (`content.test.ts`, `data.test.ts`, `structure.test.ts`, web ops tests).

| Row | Result |
| --- | --- |
| A1 FLOW-CONSTRUCTS one branch | **Kept, engine need**: the compiled AND split and join need two edges each (GRAPH-MATCHED, ENG-DEF-GRAPH; tried and refused by `defineBatch`). The message now says to write one branch as a plain sequence. |
| A2 DATA-GUARDS dead branch | Warning (the engine never enables it). |
| A3 DATA-PARALLEL shared BOM line | Kept as (b), no engine check done: since D-2 portions of one material are two formula lines, so two BOM lines. |
| A4 GMP-TYPED-FIELDS critical text | Warning; the DI-30 accuracy check on a critical hand entry still applies (GMP-CRITICAL-PARAMETERS). |
| A5 clearance second person | A clearance is significant by its block only in a packaging master (Revised Schedule M Part VIII 7: "an independent, recorded check" of counting, strip and blister machines; the master does not say which machines a line has, so the S24 reduction stays the way to one person there). A processing clearance the author does not mark significant needs one person (211.130(e) and EU 5.50 ask for the clearance and its record). Marked significant or with critical hand data, 211.188(b)(11) applies as before. |
| A6 GMP-STAGE-CLEARANCE | `stage.clearanceFrom`: a stage continues the clearance of an earlier stage sharing a room or line; refused for another area, a node that is no stage, or a stage that runs later. Designer: a choice on the stage. |
| A7 GMP-EQUIPMENT-STATUS | A status check of the same equipment (reference and class) earlier on every path, in a stage sharing a room, counts. |
| A8 GMP-BOM-CONSUMED | A line consumed on some paths only is a warning; a line never consumed stays an error (record integrity). |
| A9 hold time and timer source | Process data or a company SOP is accepted with a warning (INV-34 asks for a source, not its kind); a registration as a hold-time source stays refused. |
| A10 GMP-REPROCESSING | The maximum percentage stays required (engine and database need: G-24 and recipe-core 0622 judge the addition against it and refuse it without); age and source-batch caps optional; a re-treatment outside a loop is a warning. No procedure-reference field was added (no new refusal). |
| A11 GMP-RISK | `header.criticalityAssessment`: a pinned RISK_ASSESSMENT named on the master stands as the rationale for every non-critical item; another kind is refused. Designer: a choice in section 11. |
