# Slice 3d builder brief (coating and finishing blocks)

Branch phase-3/slice-3d (built on 3c). Read CLAUDE.md, docs/build-plan/phase-3/slice-3-plan.md (3d scope, classes,
defaults D-S3-1..3) and the slice 1 and 2 briefs (rules: new migrations only; create-or-replace from the LATEST
definition; definers hardened; tests as the app role with bypass attempts; control-id tags only where proven; existing
sweeps and the block parity test must pass; one released block version never changes).

Specs: docs/design/tablets-edition-process-and-blocks.md section B.2 (TB-01 at about line 331 onwards; each block has
Purpose, Config, Captures, Engine rules, Implements), calculations C-xx (about line 571), pharmacopoeia rule sets E.2-E.5
(about line 791). Search, do not read whole. Paraphrase regulations; rule sets are data with source and effective date.

Where the code goes:
- TB blocks are tablets-edition blocks (BlockVersion edition 'tablets'): apps/tablets-server/src/blocks/<tb-xx>.ts, one
  index per builder (builder A: blocks/coating/index.ts, builder B: blocks/forming/index.ts), both added to the
  tablets block registry in apps/tablets-server/src/features/edition-blocks.ts (each builder adds only its own line).
- SQL rows (recipe.block_data_schema, block_signature_meaning, guards) in tablets sql: builder A 0910-0929, builder B
  0930-0949; recipe-core sql 0560-0579 (builder A only) where a recipe-core function must change. Calculations needed by the database guards in the same files.
- Blocks call the slice 1 and 3a database paths (site lots and recipe.consume_lot, plant.start_equipment_use and
  instrument checks, G-06 process readings, G-09@2 and G-10@2), never their own copies.
- Tests: apps/tablets-server/test/blocks/<area>/ (server project) and unit tests of pure calculations next to them.
- Each block: full contract (handler, config and data schemas, exception rules, simulator model, golden fixture, tests).

Do not commit; report in at most 25 lines (files, blocks, rules enforced in the database, tests, defaults, open items).

Also read docs/build-plan/phase-3/review-backlog.md: the items marked for slice 3d are in scope as assigned below.
