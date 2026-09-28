# Wave brief C2: document-first MBR designer (GMP)

Full brief: `apps/M3-C2-designer.md`. Spine hand-over: `C0-spine-handover.md`. Day 1: the dc-mini spike;
report it to the lead the same day.

## Your seams
- Server: `src/features/designer/index.ts` (routes `designer.*`, GMP only; the platform already refuses them on
  the sandbox with 404), `seed(ctx)` for `tab.reference_document` rows (use `ctx.actorFor('steward')`, a
  MASTER_DATA_STEWARD on PC-QA-01), SQL 0150-0199, tests `test/designer`.
- Numbering for the document view: `flow.numberMbr(mbr)` and `flow.instanceNumber(...)` in
  `@ebmr/recipe-core/pure` (stage `2`, operation `2.1`, step `2.1.3`).
- Validation and simulation run on the server in A1 (`recipe-core` validator and simulator); the browser may
  import `@ebmr/recipe-core/pure` (browser-safe) for local helpers.
- Test packages: write to `app.config.exchangeDir/to-sandbox` (write-once); the sandbox URL is
  `app.config.otherInstallationUrl`. Stamp with kernel `sandbox.readInstallationStamp`.
- Web: `src/features/designer/index.tsx` (routes, home tile "Master records"); `DecimalField` for limits;
  `useApiQuery` for reads; a localStorage draft only for unsaved authoring edits (D7).
- E2E: `tools/e2e/specs/designer` with `officePage('GMP')` and `persona('GMP', 'author')`.
