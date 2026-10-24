# Slice 7p: a multi-point dissolution profile as one release requirement

Requirement R4 "Third check" and R8 C4 and C7 (`demo-trial-requirements.md`; owner, 23 October 2026). Branch
`phase-7/slice-7p`. Migrations: site services 1720, recipe-core 1725. Messages: EBMR-SITE-970 to 979 (a fresh block:
960 to 965 and 990 to 992 were taken). No EBMR-EXE code was needed.

## What was built

- **Specification (site services 1720).** `site.specification_test.profile`; a profile test carries no limits of its
  own; its ordered points do (`site.specification_test_point`: number, label, optional stage, time with unit min or h,
  lower and/or upper limit). Database rules: a point only on a profile test of a draft specification, numbered next,
  later than the point before it within its stage, a stage's points following one another, every point naming a stage
  or none (EBMR-SITE-971, 974); 2 to 24 points, checked at commit (EBMR-SITE-975); insert-only and audited like the
  tests. `site.draft_specification` takes `points`; the approval signs them (`site.specification_content` adds them to a
  profile test only, so every existing specification's signed content is unchanged).
- **Results.** `site.lot_test_result.point_id`; `site.record_lot_test_result` takes the point's label: an unknown point,
  no point for a profile and a point for a single test are refused (EBMR-SITE-972); the stored limits are the point's
  (the row trigger holds them) and the verdict is the generated column as before; a revision revises the same point. The
  failure resolution, the release problem and the OOS path work per point (`site.lot_test_failure_resolved`,
  `site.lot_lims_release_problem`). `site.lot_profile_status(lot)`: each profile with PASS, FAIL or OPEN.
- **LIMS.** A `lims.sample_result` may name `point`; for a profile test of the lot's specification in effect it is
  required and must be known (EBMR-SITE-973, classified WRONG_IDENTITY by the adapter); the row records the point and
  its limits and the database computes the verdict from the raw value beside the LIMS's own conformance.
- **Release checklist (recipe-core 1725).** `recipe.grel_evaluate` adds one item per profile, `G3.PROFILE_<test>`,
  GREEN only when every point has an approved result within its limits, RED "the requirement fails: ..." for a point out
  of limits, RED "the requirement is open: ..." for a missing or unapproved point; one evidence entry per point. G3.LIMS
  lists a profile's results as one entry. A lot with no profile reads exactly as before.
- **Screens.** Specifications: profile points (and stages) in the draft form, a points table on each version, *Start a
  new version from* an existing version. Lot page: a Profiles section (status, per point limits, result, LIMS value;
  QC records a point typed or from the LIMS value); a point's result is named "DISSOLUTION at 4 h" in the results list
  and its approval. Route `quality.lotProfiles` (GET). The release cockpit shows the item with its points unchanged.
- **Demo.** `cli/demo-sr-profile.ts` (one hook in `installation.ts`, opt-in `--gmp-sr-profile`, D-7p-8): Glucorvin hydrochloride SR
  tablets 500 mg (GLV-SR-500, invented), its licence, lots, masters (the GB-T-02 demo variants under its own code), one
  processing batch and two bottle orders with their finished lots posted and reviewed, specification version 1 (assay);
  `gmp-sr-profile.json` names the lots.
- **Tests.** `site-services/test/quality/profiles.test.ts` (IN-33, PR-45, IN-20, DI-31), the 7p block of
  `recipe-core/test/release/release.test.ts` (IN-05, PR-45, IN-33, IN-20; C7), `tablets-web/test/office/profiles.test.tsx`,
  browser `tools/e2e/specs/phase7/sr-profile.spec.ts` (four tests).
- **Guide.** User guide page 4, "Profiles: a dissolution profile as one release requirement".

## Decisions

- D-7p-1 (owner rule, least strict): one result per time point, the mean of the units tested as the LIMS reports it.
  The pharmacopoeial staged acceptance of dissolution (L1/L2/L3 with more units, R8 C6) is not built; residual P7P-1.
- D-7p-2: the profile is one test with ordered points rather than several tests; the release checklist shows it as its
  own item (`G3.PROFILE_<test>`) beside G3.LIMS, which still covers every result, so the database refuses a release
  while a profile is open or failed through the existing guards.
- D-7p-3: the browser test uses a product made by the demo set-up (masters, batch and finished lots), not one created
  through the designer; the profile is added to its specification on screen as version 2 and approved, results are
  entered on screen, lot 1 is released and lot 2 (4 h out of limits) is refused. Creating the product and running its
  batch on the kiosks would repeat route W's hour-long flow.
- D-7p-4: LIMS rows stay beside LIMS-lite (D-P6a-B-6): they are checked against the point and judged by the database,
  and QC records the release result (the screen offers the LIMS value). An unknown point is refused.
- D-7p-5 (R8 C4): a two-stage (acid, buffer) dissolution is the same profile with a stage on each point; the time
  starts again in each stage; acid "at or below" is an upper limit, buffer "at least" a lower limit. The browser check
  drafts one for the gastro-resistant route W product (draft only: its specification in effect is route W's).
- D-7p-6 (R8 C7): content uniformity needs nothing new: a single test with an upper limit on the acceptance value (e.g.
  AV at most 15) is required for release and judged by the database; an AV above the limit keeps the lot from release
  (proven in `release.test.ts`, "content uniformity of a low-dose tablet").
- D-7p-7: a profile's points carry labels unique within the test; results and LIMS messages name the point by its label.
- D-7p-8 (CI review): the SR demo product is opt-in (set-up CLI `--gmp-sr-profile`): `pnpm demo:setup
  --with-gmp-samples` builds it for presenters, and the E2E global set-up only when no group or the `rest` group runs
  (where `sr-profile.spec.ts` is); `--gmp-packaging` alone (release-seed and the other seed tests, the drills) no longer
  pays for it. Its master validates 10 s minimum blend and lubrication times, so the seed waits about 25 s instead of
  100 s.

## Residuals

See `review-backlog.md`, slice 7p (P7P-1 staged acceptance; P7P-2 the transfer package's certificate lists a point's
result by test code only).
