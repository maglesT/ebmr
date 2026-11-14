# Working in this repository

This is a regulated-software project: an electronic Batch Manufacturing Record system with a Tablets
edition and an Injectables edition for Indian manufacturers who export (India Revised Schedule M always
applies; US FDA and EU GMP per market; the stricter rule wins).

Read before changing anything:
- `PROGRESS.md`: current state, rules in force and next steps (short; the history is `docs/progress/history.md`,
  search it, do not read it whole).
- `REPO-GUIDE.md`: layout, commands, CI rules, how-tos.
- `docs/outline/build-outline.md`: the approved plan (v0.2). Section 11 is the phase plan.
- `docs/decisions/`: owner decisions. `docs/adr/`: architecture decisions.

Hard rules:
- Never weaken a control in `compliance/controls/` to make code or tests easier. If a control seems wrong,
  write it up for the owner; do not change `expert_decision` yourself.
- Tests that prove a control carry its ID in the test name: `[DI-22]`, `[ST-33]`, plus `[INV-xx]` for invariants.
- Keep the boundaries in `.dependency-cruiser.cjs` and exact `workspace:<version>` pins.
- No `Date.now()` or JavaScript `number` for GMP values in domain code.
- Paraphrase regulations in docs and code comments; never paste more than a short phrase of regulation text.
- Run `pnpm run ci` before pushing. Work on a branch; update `PROGRESS.md` at each milestone.
- Merge loop (decision 0032): a PR merges on its gate (the tests its change selects, `tools/ci/src/select.ts`), green on
  a head that contains main; main gets a full run after every merge and nightly; a red main stops merges until fixed or
  reverted (`fixes-main`); phase exits and releases need a full run by hand. Never narrow the gate by hand, and never add
  an `e2e-map.json` rule without its reason.
- Cadence and depth follow owner decision 0008: the goal here is software that works properly with no major
  defects; validation-grade testing (mutation targets, multi-round adversarial review) belongs to deployment. Tests
  with every feature and green CI always; one review pass per feature; a quick review at the Phase 3 exit; at the
  Phase 4 exit one review pass, the full suite, golden batches and the browser suite; at most 2 fix rounds per finding,
  then a residual for the owner; database enforcement for the regulation-required core (decision 0008 section 2); up to
  5 agents at a time, and independent slices may overlap in their own worktrees (decision 0017).

## Token economy (owner, 9 October 2026)

- Read only what the task needs. The big documents (`docs/decisions/phase-2-open-questions.md`, the outline,
  `docs/progress/history.md`) are searched for the section you need, never read whole.
- Keep command output short: `| tail -n 20`, the dot or summary test reporter, `--stat` diffs; never dump logs.
- Agents only for work across several files; an agent returns a short summary, not file contents.
- Model by task: the top model builds features and makes design and security fixes; Sonnet does quick reviews; Haiku
  does mechanical jobs (doc updates, test-list syncs, merges without logic conflicts).
- Plan before a large task; ask the owner only when a decision is genuinely theirs (otherwise take the default).
- Measured on the Phase 7 session of 18 October 2026 (where its tool output went), so avoid these:
  - Images and PDF pages were 68 % of all tool output. Never `Read` a PDF page range or a full-size screenshot
    to check text: use `pdftotext` and `grep`. To see a layout, render only the pages needed at 45–50 dpi
    (`pdftoppm -r 45`) or downscale the PNG first, and join several into one strip.
  - Watched-PR events were 10 %: about 4k tokens each, 42 times. Watch only the PR in flight, and unsubscribe as
    soon as it merges.
  - CI logs: `get_job_logs` with `failed_only` and `tail_lines` of at most 150, never the whole log.
  - The graphify skill file is 42 KB. Do not invoke the skill to read its repository notes:
    `sed -n '/^## In this repository/,/^## Usage/p' .claude/skills/graphify/SKILL.md`, then query
    `graphify-out/` directly.
  - A long session re-sends its whole context every turn. Start a fresh session after each merged slice (the
    resume notes and `PROGRESS.md` carry the state), instead of running several slices in one.
  - After a compaction, trust the summary: do not re-read `PROGRESS.md`, the plan or files already summarised.

## Skills and tools

Project skills in `.claude/skills/`:
- `fix-finding`: fixing a review finding, defect or demo report (reproduce first, database guard, new migration).
- `mutation-check`: focused Stryker on changed lines; the SQL mutation harness for database functions.
- `postgres-oracle`: ask the real PostgreSQL 16 server instead of reasoning about its behaviour.
- `local-ci`: CI and E2E as GitHub runs them, spare clusters for parallel runs, failure diagnosis.
- `graphify`: code map built at session start into `graphify-out/` (not committed). It does not see calls inside
  SQL function bodies; read its "In this repository" section before relying on it.

The rules above and the controls win over any tool or skill. Do not add a tool, plugin or skill whose rules
cut testing (fewer tests, "one check is enough", coverage or mutation targets as optional); Ponytail was
rejected for this reason. No tool or skill reduces tests named with control IDs, mutation targets, database
enforcement, audit trail, e-signature or access checks; only an owner decision sets when they run and how deep
(decision 0008). A graph answer is never evidence; the code and the tests are.
