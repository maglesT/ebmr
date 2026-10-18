# Phase 7: resume here (paused and resumed on 18 October 2026)

The owner paused Phase 7 for urgent work on another product ("pause it at some place from where it can be resumed later
from github"). Everything below is pushed to GitHub; no work exists only in a container. Read this page, then
`PROGRESS.md` and `docs/build-plan/phase-7/phase-7-plan.md` (the slice sections), then
`docs/build-plan/phase-7/review-backlog.md`. Decision 0025 (every act has a screen, no terminal to use the system) is on
branch `phase-7/slice-7g`.

## Merged into main

| Slice | PR | Content |
|---|---|---|
| 7-0 | #52 | interfaces: release identity, validation-summary approval, system description, evidence bundle v1, feed signature |
| 7a | #53 | decision 0022 fixes: signed gateway feed and mTLS, QA approval of plant rules, controlled reads, batch scope |
| 7b-1 | #54 | hardening list and review residuals |
| (notes) | #55 | these resume notes and the CLAUDE.md token rules |
| 7b-2 | #56 | stand-alone record viewer, full export of closed records, periodic evaluation pack |
| 7c | #57 | validation pack generators, DI-03 validation-summary gate (recipe-core 1250), DI-06 interface drift (kernel 1350 rebuilt from main's latest definitions, SERIES_GAP kept); review: no findings; golden 44/44 without a re-take |
| 7d | #58 | release drills, security tools and the route-by-role matrix, load driver (analytics runner in a worker thread, P6A7-8 role check kept in the worker), inactivity warning (tablets 1460), accessibility audit run (A11Y-4 to -7 fixed); review: no findings; golden run by CI's golden job (decision D-P7R-1: the local golden cluster was busy with 7e; same suite, same clock library) |
| 7e | #59 | branding (Batchwright, decision 0020), user and administrator guides, `tools/guides` (reference lists from a migration-built database, self-contained HTML and PDF); review: P7E-1 (low: a link with another scheme than http, https or mailto was live) fixed with a test; golden 51/51 |

## Merge order from here (D-P7-9, amended by decision 0025)

7g (its parts 7g-1, 7g-2, 7g-4, 7g-5, and 7g-3 still to build), then 7f (exit).
Each slice: merge main into its branch, resolve, register its new SQL functions in `tools/sql-mutation/src/targets.ts`
(with a job in `.github/workflows/mutation.yml` for a new group, same order as TARGETS), claim its migrations in
`docs/handbook/modules.yaml`, `pnpm handbook`, run every test file the slice changed (and the folders around them) and
`pnpm register:sync-tests` from those results (missing a folder fails CI's register check: it happened on #54), run the
golden batches on the clock cluster if the slice can move them, one quick review, at most 2 fix rounds per finding, PR,
merge when green.

## State of each branch

| Branch | State | What is left |
|---|---|---|
| `phase-7/slice-7g` | decision 0025 and the 7g plan | the integration branch of the 7g parts |
| `phase-7/slice-7g1` | built: administration screens (people, grants, recertification, break-glass, devices), the route-completeness `[meta]` test | modules.yaml `ts-administration`; review |
| `phase-7/slice-7g2` | done 9a33286d: main merged; incidents E2E fixed (P7G2-2: report time without seconds was refused by the contract; the screen adds `:00`, the spec takes the server's clock); E2E phase7 3/3; group `specimen-approval`; modules ts-designer/ts-alarms/ts-incidents; register synced | integrate into 7g; the completeness `[meta]` test (only on 7g-1) must drop `plantRules.setFacilityRule`, `plantRules.classifyBetaLactam` and signable `MBR_TRANSITION`; `labels.masterLabelling` and `labels.declareLabelling` still have no screen (PENDING_7G2, open) |
| `phase-7/slice-7g4` | done a393aa52: main merged; operations E2E 5/5 (demo load: routes without a session no longer look one up during maintenance; the job panel follows the job); groups first-run-setup, operations-acts, operations-demo-backups; modules kernel-operations, ts-operations, tools-install; register synced | integrate into 7g; apply D-P7R-2 to `commands-have-screens.test.ts`; residual: `/api/meta` reads the database during maintenance (the page does not call it then) |
| `phase-7/slice-7g5` (from 7g-1) | WIP 6625ec3 plus 60628136: main merged; the US e-signature certification is now enforced (recipe-core 1260: `gmp_issue_problem` from 1250 plus the check, and a BEFORE INSERT trigger on `recipe.batch_execution`; 3 `[DI-15]` tests; demo set-up records the DEMO-ONLY letter) | run `governance.spec.ts` and `screen-gaps.spec.ts`; the 64 database acts of 7g5-1 need routes and screens (decision 0025); claim the 5 unclaimed WIP files in modules.yaml (administration feature and screens; contract people, device-registry, access-governance); review whether the merge's choice of main's idle warning lost the branch's rule that device-nonce and identify requests are not activity |
| 7g-3 | not started | after 7b-2, 7c, 7d merge: screens for the system description, validation-summary approval, full export, evaluation pack and its QA sign-off, evidence bundle, validation pack, IQ, restore and upgrade drills |

## Next steps (7g, then 7f)

1. Integrate the 7g parts on `phase-7/slice-7g`: merge main, then 7g-1, 7g-2, 7g-4, 7g-5 (each already has main up to
   7d merged; 7e is merged in main by then). Expected conflicts: `targets.ts`/`mutation.yml` (keep all groups, main's
   first), the defect log and runbooks (keep all sections), generated handbook pages (regenerate), the completeness
   `[meta]` tests (apply the 7g-2 row above and D-P7R-2).
2. Finish 7g-5 (row above), then build 7g-3 (screens for the system description, validation-summary approval, full
   export, evaluation pack and its QA sign-off, evidence bundle, validation pack, IQ, restore and upgrade drills).
3. Per slice steps as above; the golden batches on the clock cluster (GB-T-03 moves with the US letter); E2E specs
   phase7, operations, administration; one quick review; PR; merge when green.
4. 7f exit: trace at 7, one review pass, the release-candidate checklist.

Decisions taken on resume (owner's standing instruction to decide and record):
- D-P7R-1: when the local golden cluster is busy, CI's golden job on the PR (same suite, same clock library) serves as
  the slice's golden run (used for 7d).
- D-P7R-2 (`commands-have-screens`): IQ, the records CLI and the validation-pack builds (bundle, generate, oq) are
  acts that wait for 7g-3's screens (listed pending 7g-3, not exempt); `register:status` (a developer tool on the
  control register) and the stand-alone record viewer (itself the reading tool) are exempt.

- D-P7R-3: market policies stay in v1.0; their acts get screens (WP3). If the GMP batch issue does not already pin a
  batch's market policies, `market.pin_policies_for_batch` runs inside the issue transaction (a step of the person's
  issue, not a screen); a golden output that moves is re-taken once with the reason in the defect log.
- D-P7R-4: the upgrade drill runs only on a sandbox or staging installation (it needs admin database access and
  creates databases); on a GMP installation the screen shows the drill records and runs the restore drill as a job.
- D-P7R-5: IQ (`runIq`) moves into `packages/validation-kit` so a route can run it and store its record; the CLI
  keeps working by importing it.

### 7g state (18 October, evening)

`phase-7/slice-7g` holds the integrated parts (9647df5d) and the scaffold for four parallel work packages (73461266:
reserved signable kinds, stub `validation` and `market` features, `// WP1..WP4` blocks in the three meta tests). The
packages build on `phase-7/slice-7g-wp1` (validation, export, records, esig), `-wp2` (continuity, drills, platform and
access configuration), `-wp3` (master-record, market, plant configuration, labelling), `-wp4` (floor, materials, batch
numbers). Then: merge the four into `phase-7/slice-7g`; root-cause the web test `justify-revision` that fails only in
full runs (and check `readings-after-refusal`); run E2E administration, operations, phase7 and sync the register (18
E2E entries wait for it); golden on the clock cluster (GB-T-03 and the US letter; D-P7R-3); one quick review that also
checks the integration's change letting the system administrator use the `people` and `deviceRegistry` routes (it must
not reach role or permission grants) and the idle-warning rule the 7g-5 merge dropped; PR; merge when green.

## Open findings to carry

- **US e-signature certification (high, from 7g-5): fixed on `phase-7/slice-7g5`** (recipe-core 1260, 3 `[DI-15]`
  tests), merges with 7g. GB-T-03 issues a US-market batch: run the golden batches in the 7g integration (the demo
  set-up now records the letter; re-take a golden output once with the reason in the defect log if it moves, D-P7-12).
  Whether a loan licensee also needs its own letter is left to the DI-15 expert decision (owner).
- A role-permission approval needs an approved change record (DI-09): the 7g-5 screen must lead the user through it.
- P7A-6 (feed signature does not cover the envelope's source time and record id): residual, low.
- F-6jb-g1 (record lock counts as a change since review): residual, fail-safe.

## Local environment notes (a fresh container needs none of these; for a resumed one)

- Clusters: main 5432, b5a 5435, b6a 5437, b6b 5439, gate6 5444, golden6e 5449, the golden clock cluster g6a1 5451
  (`EBMR_FAKETIME_FILE=/var/lib/postgresql/faketime-g6a1/offset`,
  `EBMR_GOLDEN_CLOCK_LIB=/usr/local/lib/ebmr/golden-clock.so`). 7d kept its drill databases `ebmr_drill6a_e2e_7d01` and
  `ebmr_drillrc_e2e_7d01` on 5439 (the first takes 12 minutes to rebuild).
- Golden runs: never start a second golden run while one is alive (a killed background run's workers can survive and
  move the shared clock file; GB-T-01 then fails with "the golden clock only moves forward"). Check `ps` first.
- A 4-CPU container cannot run more than about three suites at once: clusters crash under memory pressure and restore
  tests time out (load, not code).
- E2E on a spare cluster needs both `EBMR_PG_ADMIN_URL` and `EBMR_PG_PORT`; always under `flock /tmp/ebmr-e2e.lock`.

## After Phase 7

7f exit (trace at 7, one review pass, the release-candidate checklist), then the heavy run on the pod (24 pod hours,
D-P7-3), then the demo server (owner to provide a server, SSH and a domain; decision 0021 and 0025), then Tablets v1.0.
