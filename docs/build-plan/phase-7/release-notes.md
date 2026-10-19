# Batchwright Tablets v1.0.0-rc.1: release notes

The first release candidate of the Tablets edition (Phases 0 to 4, 6, 6A and 7; decision 0010). The validation pack
(`pnpm validation:generate`, rebuilt from the evidence bundle, D-P7-13) holds the full release notes, the known issues
and the open expert decisions generated from the register; this page is the short form for the repository.

## What the release holds

- The compliance kernel: identity and access, e-signatures with their manifestations and seals, the audit trail with
  hash chains and external anchors, database time, records retention, true copies, exports and the restore and upgrade
  drills (Phase 1).
- The recipe engine and designer: master batch records with change control and QA approval (Phase 2).
- The Tablets edition: dispensing, granulation, compression, coating and packaging with in-process checks, equipment
  and the shop floor, review by exception and release per market (India Revised Schedule M always; US FDA and EU GMP
  per market; the stricter rule wins), the India specifics (Phases 3 and 4).
- Integrations: ERP and WMS, QMS, LIMS, LMS, CMMS, EMS, OPC UA and the site gateway with its signed feed and mutual TLS
  (Phase 6, 7a).
- Advisory analytics (Phase 6A): SPC, capability, drift and deviation rates, multivariate monitoring, audit-trail
  flags, review priority and the golden-batch profile, none of which changes GMP data.
- Phase 7: the stand-alone record viewer, full export of closed records, the periodic evaluation pack and readability
  report, the validation pack generators with the validation-summary (DI-03) and interface-drift (DI-06) interlocks,
  release drills, security verification, the inactivity warning, branding (Batchwright, decision 0020), the user and
  administrator guides, and a screen for every act (decision 0025).

## Known issues (medium and low; no critical or high is open)

| Id | Severity | Summary |
|---|---|---|
| P7X-1 | medium (DI-06) | The drift interlock checks that an adapter is described, not that it runs on the endpoint host and transport its description names. |
| P7X-2 | low (DI-06) | Outbound ERP postings, reconciliations and mirror syncs run under an adapter's identity without the drift check (the server starts no such worker for an undescribed adapter). |
| P7A-6 | low (DI-31) | The v1 feed signature does not cover the envelope's source time and record id (stored metadata; GMP times come from the signed payload). |
| F-6jb-g1 | medium (IN-05) | A record lock counts as a change since review: the next market's signer acknowledges the items again (fails safe). |
| 6jc-R14, P6A7-5, P6A7-9 | see the pack | Carried from Phases 6 and 6A (`compliance/validation/open-findings.yaml`). |
| M7-residual | P1, owner | Mutant `iam.first_run_setup#11`: the set-up token's expiry compared with `>` or `>=` differs only at one microsecond; no test can reach it. |
| Tooling | - | The IQ checks and the build-status tool were not triaged in the mutation campaign (47 % and 70 % in their high-risk zones); 58 equivalent-mutant entries of earlier phases no longer fit their mutants. Both for the deployment re-run. |

## Not in this release candidate (deployment)

The reference-site load test and the soak (D-P7R-7); the expert's decision on every control (246 PENDING); the
customer's IQ, OQ and PQ; the external penetration test; the screen-reader user test; production signing and seal keys;
migration of data from another system (D-P7-8).

## Build statuses at the release candidate (D-P7-2)

`pnpm register:status` from the release candidate's bundle: 111 VERIFIED, 13 IMPLEMENTED, 122 SPECIFIED. Below the
147 VERIFIED that D-P7-1 item 1 expected, with no failing test behind the gap: the drafts held at IMPLEMENTED by rule
(DI-51, DI-52, DI-53, PR-61), listings in the older short form (file and title without the describe) that the
build-status tool does not match, two core-class controls without a database test among their listed tests (PR-60,
DI-48), two critical limits whose boundary tests are not listed (PR-08, PR-29) and IN-12 (its tests name no
implementation). Completing those listings is a deployment item before the validated build.
