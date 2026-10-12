# Phase 4 review backlog

## Slice 1 quick review (12 October 2026)

Fixed in slice 1 with regression tests: container work in the INV-35 involvement set; the batch evidence epoch moves
when a consumed lot's status or LIMS results change; epoch bumps limited to the audit review's scope and window; the
high-water mark taken from the signed content; item dispositions re-opened with the review cycle; QUERIED, RESPONDED
and ESCALATED gated on GMP; a weighed close from one balance within the container's window; audit scope widened to
IPC checks, device readings, campaigns and a packaging order's parent containers.

Backlog:
- Low: the epoch triggers run a lookup on every `kernel.audit_event` insert (measure with the performance baseline).
- Low (by design): `container_release_problem` skips ALERT-severity exceptions with no deviation.
- Deployment: the GMP sweeper's secret is written to a plaintext demo file (`gmp-service-keys.json`); production needs a
  secret store.
- Test gap (slice 1 fix 6): the rule that a critical item is escalated only after its detail was opened (EBMR-REV-055)
  has no test yet; add it with the slice 1c screens or in slice 2.
- Note: recipe-core 0719 sets `check_function_bodies = off` because it names a table that recipe-core 0740 creates;
  apply order is by file number within a source, so 0719's functions are only called after 0740 exists.

## Slice 2b open items (builder report, 12 October 2026)

- For slice 3 (G-REL): wire `site.extra_testing_problem`, `site.lot_sample_problem`, `tab.finished_lot_of` and the
  release of a finished lot out of QUARANTINE into the release evaluator.
- Residuals: MBR IPC limits are not part of the pharmacopoeia-edition review; API retention "one year after the last
  product lot containing it" and the US annual visual examination of reserve samples are not built; return to stock
  and the chemical-recovery act of returned goods wait for the release model and reprocessing.

## Slice 2c open items (builder report, 12 October 2026)

- The e2e demo seed `--gmp-packaging` marks its second batch released for packing with a demo shortcut (a superuser
  update with triggers off and a placeholder hold-point signature in the stored state). It is test data only, but it
  must be replaced by the real H-PACK signature through the routes in slice 3 (with the release cockpit) so no demo
  record carries a placeholder signature.
- The deviation screens take the owner as a typed person id; the deviation contract needs person names (slice 3
  screens).

## Slice 2 quick review (12 October 2026)

Fixed in slice 2 with regression tests: evidence matched by hash alone in recipe-core 0601 and 0716 (now the stored
bytes must match, DI-24); the deviation classifier and the impact recorder excluded from concluding, closing and
signing the impact; the demo-shortcut seeds refuse a non-demo database; a link with CONFIRMED impact keeps release
blocked after the deviation closes (D-2a-9, open for the owner); the OOS cited on a RELEASE-result revision must be
about that test.

Backlog:
- Medium: `packaging_master_problem` (recipe-core 0761) accepts TB-24 anywhere in the procedure, including an optional
  branch; require it on every completing path (slice 3 or the flow validator).
- Medium (Injectables): `recipe.packaging_completion_block` has only the Tablets row, so an Injectables packaging order
  is refused until its edition adds one (Phase 5).
- Low: `tab.post_finished_lot` does not check the posted quantity against the packed counts (slice 3, with
  reconciliation at release); pharmacopoeia edition marking is a role check without a signature; `tab.reels_in_use` is
  declared immutable but calls recipe functions.

## Slice 3c open items (builder report, 12 October 2026)

- Residual (lead's decision, option b): the `--gmp-packaging` demo seed keeps its labelled DEMO SHORTCUT for the bulk
  parent's H-PACK (behind the two-step demo gate). A real H-PACK through the routes needs a valid GMP master run to its
  end: the designer gate requires every BOM line consumed, a clearance and a yield per material stage (GMP-BOM-CONSUMED,
  GMP-STAGE-CLEARANCE, GMP-STAGE-YIELD), and the ERP order needs at least one BOM line matching the master exactly
  (recipe-core 0602), so a short "hold point only" master is refused. GB-T-01 proves the real path (golden batch
  `stages.ts`); the slice 7 golden batch GB-T-02, which runs to release, gives the e2e packaging demo a real parent.
