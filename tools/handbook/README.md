# tools/handbook

Generates the developer handbook's reference pages from the repository and checks the handbook's links (owner decisions
0013 and 0014).

- `pnpm handbook` writes `docs/handbook/code-map.md` and `docs/handbook/reference/{db-catalogue,control-map,error-codes}.md`
  from the migrations, the contract's namespace files, the control register and `docs/handbook/modules.yaml`.
- `pnpm handbook:check` exits non-zero when a generated page is out of date or a check fails:
  - every migration, server feature, contract namespace file and screens folder belongs to exactly one module of
    `modules.yaml` (matching is ordered: the first module whose pattern matches claims the file);
  - every folder under `packages/`, `apps/` and `tools/` is some module's package;
  - every module page exists (or is listed under `pending:`) and is linked from the handbook README;
  - every relative link in `docs/handbook/**/*.md`, and the `Handbook:` line of each package or feature README, reaches
    a file; `#sym=<name>` needs the file to define `<name>`; `#anchor` into a page needs a heading with that slug;
  - a migration numbered above `migration_header_from` carries a `-- Handbook: <page>` line in its first 10 lines.
- `tools/handbook/test/handbook.test.ts` runs the same checks in the test suite and proves each on a fixture.

When you add a migration, a feature folder, a contract file or a screen folder, add it to a module in `modules.yaml`
(or let an existing pattern claim it), then run `pnpm handbook` and commit the regenerated pages.

Handbook: [modules/tools.md](../../docs/handbook/modules/tools.md)
