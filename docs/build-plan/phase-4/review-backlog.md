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
