# Phase 2 common brief (read fully before starting)

You are implementing one module of Phase 2 (recipe engine and designer) of the eBMR system in the git worktree
/home/user/ebmr-p2 (branch `phase-2/recipe-core`). Several agents work in this same worktree at the same time.
IMPORTANT: work only in /home/user/ebmr-p2, never in /home/user/ebmr (another branch is checked out there and a long
test run uses it).

## Hard rules
- Do NOT commit, push, switch branches, stash, reset, or run `pnpm install`/`pnpm add`. The lead commits and installs.
- Only create or edit files inside YOUR paths (listed in your module brief) plus `compliance/controls/<ID>.yaml` for the
  controls you implement (only `implemented_by`, `tests`, `build_status`). Never edit other modules' files, the kernel,
  package.json files, root configs, or test/support files; ask in your final message instead.
- Dependencies available: packages/expr has decimal.js 10.6.0 and @lhncbc/ucum-lhc 7.1.9; packages/recipe-core has
  @ebmr/kernel, @ebmr/expr, pg, xstate. Root dev: vitest, fast-check. Need another one? Say so in your final message.
- Read first: CLAUDE.md, REPO-GUIDE.md, docs/adr/README.md and the ADRs named in your brief, the outline sections named
  in your brief (docs/outline/build-outline.md), and the control files compliance/controls/<ID>.yaml of your controls
  (`behaviour` and `catalog_test` are the requirement; `sources` the basis; `proposed_modify` notes are outline
  proposals the expert has not yet approved: implement them switchable where the note says so).
- Dependency direction (lint-enforced, .dependency-cruiser.cjs): expr imports nothing internal; recipe-core imports only
  kernel and expr; packages never import apps.

## Conventions
- TypeScript strict, ESM, `.ts` import suffixes, `import type` for types. No `Date.now()`/argument-less `new Date()` in
  src. **No JavaScript `number` for GMP values** (quantities, limits, yields, results): use the expression language's
  decimal type (decimal.js at 34 significant digits, wrapped). Counts and indices may be numbers.
- Pure logic first: parsing, validation, simulation and engine steps are pure functions with no I/O; persistence is a
  thin layer.
- Tests: Vitest; property-based tests with fast-check where a law exists (round-trips, monotonicity, invariants);
  every test that proves a control or invariant carries its IDs in the name, e.g. `it('[DI-34][INV-19] ...')`.
  Implement at least one test per `catalog_test` line of each of your controls (the parts that belong to your module;
  say which lines belong to later phases).
- Messages shown to users are plain language first, and name the rule and control (e.g. "Timer lacks validation
  reference (ST-37)").
- Paraphrase regulations; never copy more than ~10 consecutive words of regulation or pharmacopoeia text.
- Typecheck `npx tsc -p tsconfig.json`, lint `npx eslint <your paths>`, run your tests with `npx vitest run <your test
  dir>`; before finishing run the whole suite `npx vitest run` and report failures in other modules (do not fix them).
- Write a README.md in your src folder: purpose, public API, invariants/controls covered, how other modules call it.

## Final message
Files created, public API (functions/types) other modules should use, controls/invariants proven (test names), what
belongs to later phases, and anything the lead must do (edits outside your paths, dependencies, open design questions
for the owner).
