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
