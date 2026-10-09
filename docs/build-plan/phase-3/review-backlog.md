# Phase 3 review backlog

Medium and low findings from the Phase 3 quick reviews and the open items the builders left, for later slices
(decision 0008: critical and high are fixed at once; medium and low wait here). Each line names the slice that
should take it.

## Slice 1 quick review (9 October 2026)

Fixed in slice 1: findings 1 and 2 (HIGH: the plant guards trusted caller-supplied product and batch; one person could
skip the two-person cleaning check by choosing CIP), and 3 and 4 (MEDIUM, fixed because they break a core control:
abandoning a cleaning reset the dirty-hold clock; the clearance signature did not bind its result).

| # | Severity | Finding | Where | For |
|---|---|---|---|---|
| 5 | Medium | No retest command: a lot past its retest date can never be used again (fails safe) | site-services 0710, 0712 | Slice 5 (LIMS-lite records the retest result) |
| 6 | Medium | The release route and quantity are not in the content the release signature covers (the signer is the actor, so the effect is limited) | site-services 0710 material_lot_content | Slice 2 |
| 7 | Medium | A lot received as INTERMEDIATE skips the identity rule; the material kind comes from the receiver and only QA's signature over content showing the kind stands in the way | site-services 0712 receive_lot | Slice 5 (ERP stub supplies the material master) |
| 8 | Low | Close and IPC hold race: a container can stay CLOSED with a hold row (still unusable, but QA cannot sort or release it); a container opened during a failing check can miss the hold | recipe-core 0422 apply_hold | Slice 3 (press blocks) |
| 9 | Low | Utility feed freshness is not checked: the latest OK reading counts however old | recipe-core 0403 | Slice 3 |
| 10 | Low | Clearing a signalled equipment failure (REPAIRED) is a one-person step | recipe-core 0403 | Slice 2 |

## Open items the builders left

- PR-18: picking a newer lot than the oldest usable one needs a reason (deferred; FEFO picking arrives with
  dispensing in slice 3).
- The destruction witness meaning uses the VERIFIER class, so the witness window and room checks do not apply.
- `recipe.consume_lot` and the container commands bind to `recipe.batch_execution`, which holds sandbox batches only
  today; tests insert batch rows as superuser. The GMP batch record arrives with the execution paths of slice 2.
- `recipe.consume_lot` does not check the batch's edition or execution state (slice 2).
- Container press codes are not checked against `plant.equipment`; IN-35 (c) (missed-check timer, alarm, deviation)
  waits for the press blocks (slice 3).
- Refused label scans are not logged, because the refusal rolls back the command (slice 2, exception register).
- Room sub-locations, adjacent lines (PR-35), tooling and sieve checks (INV-24), and the link between equipment and the
  room the batch is in (slice 3).
- Raising the D-S1-5 crossing flags as exceptions (slice 2).
- Freshness-bounded mirrors of site data for a second edition database (D-S1-1, Phase 5).
