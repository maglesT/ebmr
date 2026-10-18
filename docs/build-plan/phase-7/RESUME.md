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
| 7d | (next PR) | release drills, security tools and the route-by-role matrix, load driver (analytics runner in a worker thread, P6A7-8 role check kept in the worker), inactivity warning (tablets 1460), accessibility audit run (A11Y-4 to -7 fixed); review: no findings; golden run by CI's golden job (decision D-P7R-1: the local golden cluster was busy with 7e; same suite, same clock library) |

## Merge order from here (D-P7-9, amended by decision 0025)

7e, then 7g (its parts 7g-1, 7g-2, 7g-4, 7g-5, and 7g-3 still to build), then 7f (exit).
Each slice: merge main into its branch, resolve, register its new SQL functions in `tools/sql-mutation/src/targets.ts`
(with a job in `.github/workflows/mutation.yml` for a new group, same order as TARGETS), claim its migrations in
`docs/handbook/modules.yaml`, `pnpm handbook`, run every test file the slice changed (and the folders around them) and
`pnpm register:sync-tests` from those results (missing a folder fails CI's register check: it happened on #54), run the
golden batches on the clock cluster if the slice can move them, one quick review, at most 2 fix rounds per finding, PR,
merge when green.

## State of each branch

| Branch | State | What is left |
|---|---|---|
| `phase-7/slice-7e` | built (branding, guides, `tools/guides`), not reviewed | modules.yaml entry `tools-guides` (page modules/tools.md, src tools/guides/src, tests tools/guides/test/**); golden run (vendor-name tests read outputs only); apply the guide changes of 7g (below) after 7g merges or in 7g; review |
| `phase-7/slice-7g` | decision 0025 and the 7g plan | the integration branch of the 7g parts |
| `phase-7/slice-7g1` | built: administration screens (people, grants, recertification, break-glass, devices), the route-completeness `[meta]` test | modules.yaml `ts-administration`; review |
| `phase-7/slice-7g2` | WIP 4f3fc4c: MBR signing, plant-rule proposal and approval, incidents screens; tablets 1479; E2E master-records and plant-rules pass | `tools/e2e/specs/phase7/incidents.spec.ts` fails at line 70 (CERT-In report time typed from the browser clock; check the server's refusal); then summary items: targets, modules.yaml, which completeness routes leave the pending list, guide text |
| `phase-7/slice-7g4` | WIP f438066: kernel 1375 (set-up token, first-run set-up), 1376 (worker acts, backup requests, 3 permissions), tablets 1485 (GMP refusal of demo acts, backup reads); `features/operations` routes and screens, `ns/operations.ts`, `meta.setupRequired`, `meta.openapi`; `tools/install`; `[meta]` `commands-have-screens.test.ts`; server, web, installer and kernel tests pass | run `tools/e2e/specs/operations/operations.spec.ts` (a selector was fixed, the rerun was cut off); targets for the new functions; modules.yaml entries (the handbook test fails until then) |
| `phase-7/slice-7g5` (from 7g-1) | WIP 6625ec3: the 25 gap routes have screens; access-governance routes and screens (role-permission requests, delegations, US e-signature certification); `[meta]` test `db-acts-have-routes` (64 database acts without a route listed, 7g5-1) | run `tools/e2e/specs/administration/governance.spec.ts` and `screen-gaps.spec.ts`; the 64 acts of 7g5-1 need routes and screens (decision 0025) |
| 7g-3 | not started | after 7b-2, 7c, 7d merge: screens for the system description, validation-summary approval, full export, evaluation pack and its QA sign-off, evidence bundle, validation pack, IQ, restore and upgrade drills |

## Open findings to carry

- **US e-signature certification not enforced (from 7g-5):** `iam.assert_us_esig_certification` is called by no batch
  issue path, so the BLOCK policy for a US-market issue is not enforced. Treat as high (Part 11's certification before
  use): fix in a 7g part or in 7f, with a test that a US-market batch issue is refused without the certification.
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
