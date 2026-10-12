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
