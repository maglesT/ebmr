# Decision record 0029: release stays strict while a linked deviation is open

- **Date:** 10 November 2026
- **Decided by:** the project owner (maglesT), relayed by the lead (session_01PybpFvcfiLdV8mgoVVWXTk) to build session 12
  during the lean review: "keep release strict".
- **Concerns:** tablets 1907 (`dv.batch_number_link`, guard fact `dv.status_fact`), the release guard's refusal
  `EBMR-DV-001`, the release checklist item `G2.DEVIATIONS_LINKED`.

## Context

With a Deviations link (MEDHANTA slice 2), a batch's deviation is stored only as its Deviations number, and the database
refuses a lot or container release until every linked number is closed or rejected in Deviations (`EBMR-DV-001`). The
lean review asked whether a binding clause requires this. The header of tablets 1907 grounds the rule in 21 CFR 211.192;
that clause asks for the records to be reviewed and any unexplained discrepancy to be thoroughly investigated before
release, and for the investigation to be recorded. It does not, read alone, forbid release while a linked investigation is
still open (a quality unit may conclude that a discrepancy does not affect the batch and record that conclusion). So the
1907 header stretches 211.192.

## Decision

- **D-0029-1:** release stays strict. A lot or container is not released while any deviation or exception linked to it
  (a local one, or a Deviations number) is open. `EBMR-DV-001` and its tests stay as they are.
- **D-0029-2:** the basis of that refusal is this owner decision, supported by (not derived from) 21 CFR 211.192,
  211.100(b) and revised Schedule M 18.2.2 and 18.5.12 as control IN-05 cites them. Where code or documents give the basis
  of `EBMR-DV-001`, they cite this record.
- **D-0029-3:** the header of tablets 1907 is not edited (applied migrations are checksummed and never edited). This record
  corrects it; PROGRESS.md and the header of the next tablets migration say so.

## Consequences

No behaviour changes. A firm that wants release with an open, assessed investigation would need a new owner decision.
