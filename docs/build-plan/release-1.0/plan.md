# Batchwright Tablets v1.0: release plan

Status: **approved, 3 November 2026: the owner took every recommendation of section 4 (decision 0027).** R1 is under
way.

## 1. Where we start

- **v1.0.0-rc.1** was tagged on 19 October 2026 at the Phase 7 exit (`batchwright-tablets-v1.0.0-rc.1`; decision 0024;
  `docs/build-plan/phase-7/release-notes.md`). Its gaps, as its notes list them:
  - Build statuses: 111 VERIFIED, 13 IMPLEMENTED, 122 SPECIFIED, short of the 147 VERIFIED that D-P7-1 expected. No
    failing test is behind the gap; it is listing work:
    - test listings in the old short form, which the build-status tool does not match;
    - PR-60 and DI-48 without a listed database test;
    - PR-08 and PR-29 boundary tests not listed;
    - IN-12 (its tests name no implementation).
  - Known issues, medium and low: P7X-1, P7X-2, P7A-6, F-6jb-g1, the carried 6jc-R14, P6A7-5 and P6A7-9, the
    mutation residual M7, and two tooling notes.
- **Since rc.1** (decision 0026), the dynamic library: blocks as data, QA-approved and versioned; formulations assembled
  in the designer; batches generated from them (S0 to S11). Acceptance: three very different tablets, from the
  catalogue to a released lot, on screens only, with no tablet-specific code. Green on the pod in run 370.
  - The TB blocks leave the palette (O-6).
  - Two small fixes from the S11a runs.
  - The extras are frozen (code and tests kept, no new work).
  - Hard capsules are deferred.
- Open pull requests and branches:
  - PR #84 (S11b, CI running);
  - `dyn/o6` with `dyn/s11-findings` on top (one PR after #84);
  - `dyn/o7` (parked, see decision V5).

## 2. What v1.0 is

The Tablets edition as rc.1 described it, plus the dynamic library as the way a company builds its own products. It
also carries the existing route masters (TB-01 to TB-24), which keep running. As for rc.1, the release is the software
and its validation pack. The customer's validation is listed as deployment work and is not part of the release
(section 5).

## 3. Steps

| Step | What | Done when |
|---|---|---|
| R1 | Merge PR #84; one PR for O-6 and the S11a findings; merge it | both green on CI and merged |
| R2 | Close the rc.1 listing gaps: rewrite short-form listings in the full `<file> > <describe> > <title>` form; list a database test for PR-60 and DI-48 (write one if none exists); list the PR-08 and PR-29 boundary tests; fix IN-12's listing; list the library's controls (S1 to S11) where a passing tagged test proves them | `pnpm register:status` on the final bundle: every Tablets-gate control VERIFIED, except the five drafts (IMPLEMENTED) and the three with an Injectables part (SPECIFIED), as D-P7-1 set |
| R3 | One review pass of the library code (S0 to S11, O-6; decision 0008), on design and serious defects, plus two pieces no review has covered yet: the migration dry run (`tools/drills/src`, DI-48) and the pack builder (`packages/validation-kit/src/pack`, IN-12); its entry in `compliance/validation/reviews.yaml` records that scope; critical and high fixed, each with its own test, at most two rounds; the rest listed as known issues | no open critical or high |
| R4 | Guides: a user-guide chapter "Build a product from the library" (author, QA approval of blocks, values form, sandbox run, approval) and the kiosk's generic library step; admin-guide notes (loading the catalogue, retiring a block, the TB blocks leaving the palette); `pnpm guides:lists`, `pnpm handbook` | guides build, handbook check passes |
| R5 | Release notes v1.0 (what the release holds, the library, known issues, not in this release); the validation pack regenerated from the final bundle (`pnpm validation:bundle`, `validation:generate`); SBOM and signed manifest from CI | pack generated from the final run's evidence |
| R6 | The final run: full CI with every E2E group, the golden batches and the trace at phase 7, green in one run (at most two final runs, as at rc.1); then the tag (version per decision V1) | tag pushed on the merge commit |

Estimate: R1 is about a day of CI. R2 and R4 take about a session each. R3 is one review session plus fixes. R5 and R6
take about half a session plus one full CI run (about 60 minutes on the pod, about 77 on GitHub-hosted runners).

## 4. Decisions for the owner

| Id | Question | Options | Recommendation |
|---|---|---|---|
| V1 | Version of this release | (a) `v1.0.0-rc.2`; (b) `v1.0.0` | (b) `v1.0.0`: rc.1's gaps are closed and the library is accepted; the customer's validation stays deployment work, as rc.1 said |
| V2 | The frozen extras (injectables stay out; site gateway, simulators, analytics, integrations, QP package, contract giver, EU importer register, PQR, dashboards, CAPA, training, incidents, alarms, kiosk extras) | (a) ship as they are, tested and documented as in rc.1; (b) ship but switched off by default; (c) leave out | (a): they were verified at rc.1 and stay in CI; switching them off would be new work and new tests |
| V3 | Mutation testing at this release | (a) none: validation-grade testing belongs to deployment (decision 0008); (b) a focused campaign on the library's SQL and TypeScript only, in a box of a few pod hours, as decision 0024 did at rc.1 | (b) for the new guard code (library limits, entries, smart fields, the skeleton changes), reported against targets; Priority 1 always fixed |
| V4 | Release tests inside the batch record | (a) not in v1.0: release tests stay QC's record on the lot (D-S11-R1); (b) add QC roles that sign library release-test steps on the floor | (a); (b) is a feature for after v1.0 |
| V5 | O-7 (b): frozen E2E groups weekly | (a) keep every group on every PR until the release; (b) weekly | (a) until v1.0 is tagged; reconsider after |
| V6 | Where CI runs | the pod (needs a restart and runner set-up) or GitHub-hosted runners (now, `CI_RUNNER=github`) | GitHub-hosted for R1 to R5; the pod for the final run if it is up, it is faster and cheaper |

## 5. Not in this release (deployment, as at rc.1)

- The reference-site load test and the soak (D-P7R-7).
- The expert's decision on every control, and re-verification of any MODIFY.
- The customer's IQ, OQ and PQ on its own installation.
- The mutation targets of decision 0008 on the validated build.
- The external penetration test and the screen-reader user test.
- Production signing and seal keys.
- Migration of data from another system.
- Hard capsules (deferred by the owner, 2 November) and Injectables (decision 0010).
