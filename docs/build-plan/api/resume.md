# API edition (substance): resume notes (6 November 2026, 15:10 UTC)

Read with: `plan.md`, `handover-a0.md` (sections "A1a done", "A1b paused", "A2 part 1", "A2 part 2"), CLAUDE.md and
`docs/build-plan/capsules/plan.md` section 8 (rules learnt). Lead: session_01PybpFuUgimTwCNtTsK7cf1. Report each merge
in 2 lines; lead audit before each merge; squash-merge on green.

## PRs and branches (merge in this order, each on green)

| # | Branch | What | State |
|---|---|---|---|
| #154 | `ci-pod-playwright` | CI: pod E2E uses the preinstalled chromium (/opt/pw-browsers, revision 1194), no apt/sudo | lead: merge on green |
| #153 | `fix-whole-lot-weighing` | tablets 1903 (was 1808; renumbered 16:05, main has 1902): a GMP weighing that uses up a whole lot is accepted (EBMR-EXE-078, TB01 FEFO); audit tests added | lead audit done (MINOR, fixed): merge on green, before the API PRs |
| #143 | `api-a1b-r` | A1b: catalogue v1 (11 blocks, every field with its clause), 15 AS controls, substance 5003 | lead CLEARED; CI blocked by the pod only |
| #144 | `api-a2-r` | A2 part 1: intermediate lot (site-services 1732, substance 5001); contract names the existing RELEASE_FOR_FURTHER_PROCESSING | waits for #143 |
| #145 | `api-a3-r` | A3: CoA (substance 5002) trimmed to SM XII 11.3 / Q7 11.41-11.43; read class in tablets 1904 (was 1807; claimed in modules.yaml with site-services 1733); telephone site-services 1733 | lead approved the trim; waits for #144 |
| #150 | `kernel-retention-api-r` (base `api-a1b-r`) | kernel 1405: RET-2026.2, IN and EU retest-distribution rows (AS-24) | retarget to main after #143 merges; then merge |
| — | `api-a2b` (stacked on `api-a2-r`) | A2 part 2: B and C consume their intermediate through G-07; C to a released API lot | no PR yet: open after #144 merges |
| — | `api-genealogy-intermediate` (stacked on `api-a2b`) | recipe-core 1876: genealogy crosses intermediate lots (edge kind OUTPUT) | no PR yet: open with/after A2 part 2 |

## Blockers right now

- **Pod CI:** the runners have no passwordless sudo. E2E jobs failed in `tools/ci/playwright-install.sh` (#154 fixes
  that), and `packages/kernel/test/review/f55.test.ts` uses `sudo -n` (lead: owner adds NOPASSWD; never skip f55, no
  helper change). After that the lead re-runs #143's failed jobs (shard 4 timeout, nine E2E groups, the gate).
- **#147** (injectables, one dosage-form → edition map `flow.productLineOf`) must land before the A1b on-screen E2E and the
  "Batchwright API" header (ui-kit brand edition 'API'; HEADER_OF_LINE substance → 'API').

## To do after the merges

1. DONE (api-a2b fdd7c93): A2 part 2 test uses the whole lot (A 50 kg, B 42.5 kg; consumptions end at 0). Needs #153 in the base to pass.
2. After #143 merges: on #145 add `compliance/controls/AS-17.yaml` (SM XII 11.3.1-11.3.4; Q7 11.40-11.43), add AS-17 to
   `recipe.engine_name` in 5002, tag the CoA tests [AS-17]; the DI-05/DI-30 test in substance-edition.test.ts checks the
   names equal the files. Add the AS test names that A2 part 2 and genealogy listed (AS-03, AS-04, AS-16) to their AS files.
3. A1b E2E on #147 (own Playwright group; drives the generic library-step form only; AS-14 via G-21 label specimen).
4. Then the plan's next slices (A4 recovery/rework, ...), small, one PR each.

## Numbers in use

substance 5000-5003; site-services 1732, 1733; tablets 1903 (#153), 1904 (#145) (lead, 16:00; main already has tablets 1902); recipe-core 1876; kernel 1405. Ask the lead for every
new shared number; substance numbers 5004+ are ours.

## Lead rulings of 6 November (in force, beyond plan.md)

- Intermediate release: the existing lot-machine event RELEASE_FOR_FURTHER_PROCESSING, exposed in the contract (no DB
  change). COA_APPROVED meaning approved. No `report.coa_v1`, no production-release delegation.
- Catalogue: a clause line per field; `critical` only on time limits (Q7 8.20), IPC results (8.30) and yield (8.14); no
  YES_NO, limit slot or CHOICE without a clause; one isolation block per type (API-FILTER, API-CENTRIFUGE).
- AS-14 specimen = G-21 label specimen (EBMR-LBL-060). Retention: IN and EU rows only (no US: Q7 is guidance there).
