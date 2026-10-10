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
| 6 | Medium | The release route and quantity are not in the content the release signature covers (the signer is the actor, so the effect is limited) | site-services 0710 material_lot_content | Fixed in slice 2 (site-services 0720) |
| 7 | Medium | A lot received as INTERMEDIATE skips the identity rule; the material kind comes from the receiver and only QA's signature over content showing the kind stands in the way | site-services 0712 receive_lot | Slice 5 (ERP stub supplies the material master) |
| 8 | Low | Close and IPC hold race: a container can stay CLOSED with a hold row (still unusable, but QA cannot sort or release it); a container opened during a failing check can miss the hold | recipe-core 0422 apply_hold | Slice 3 (press blocks) |
| 9 | Low | Utility feed freshness is not checked: the latest OK reading counts however old | recipe-core 0403 | Slice 3 |
| 10 | Low | Clearing a signalled equipment failure (REPAIRED) is a one-person step | recipe-core 0403 | Fixed in slice 2 (recipe-core 0460) |

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

## Slice 2 notes

- Slice 2 (0720, stricter default): a lot with a passing identity result can be released only on IDENTITY_TESTED, and a
  person who consumed from a lot is a performer of it, so cannot witness its destruction. Existing lot signatures are
  superseded by the new content and must be signed again (no effect on a fresh database).

## Slice 2 quick review (10 October 2026)

No critical or high findings. Fixed in slice 2 because they touch core rules (signatures bound to what they approve,
segregation): 1 (skip, void and invalidation approvals not bound to the act they approve), 2 (VOID_ATTEMPT without
`point` not refused after a result exists), 3 (QA-only disposition read QA roles from the batch's own policy), 4 (the
abort requester could sign one of the two approvals), 5 (the QA approver of a fail-to-pass correction was not checked
for involvement), 7 (every consumption superseded the lot release signature; the witness exclusion the 0720 header
promised was not built).

| # | Severity | Finding | Where | For |
|---|---|---|---|---|
| 1b | Medium | The deviation or investigation an invalidation cites is free text; the database does not check it exists (D-S2-2) | recipe-core 0452 | Slice 5 (deviation-lite) |
| 6 | Low | The evidence of a fail-to-pass correction is not tied to a stored document | recipe-core 0452 | Slice 5 |
| 8 | Low | `plant.equipment_repair` has no unique index on the failure event; only the repair matching the open failure can be verified | recipe-core 0460 | Slice 3 |

## Slice 2 hand-over review (10 October 2026)

No critical or high findings. Fixed in slice 2: 1 (a step stayed stuck in ATTEMPT_HANDED_OVER when the incoming person
never came; the incoming person was not checked for being active and holding the performer role), 2 (the hand-over's
supervisor, QA approver, outgoing and incoming persons could disposition its STEP_HANDED_OVER exception), 3 (the QA
approval was not bound to the step, persons and reason; with review finding 1 above), 4 (the outgoing person could still
correct entries), 6 (the hand-over's supervisor and QA approver could verify the step; stricter default: refused).

Design note for the owner (5): the incoming performer's PERFORMED signature covers the step content including the
outgoing performer's entries, which the outgoing person does not sign; the verifier covers them all. This follows the
outline (5.2.3, L-07).

## Slice 2b quick review (10 October 2026)

No critical or high findings. The reviewer diffed all 30 re-created functions of 0502 against their previous
definitions: only the content-source switch changed. Fixed in slice 2b: 1 (for a GMP batch plant.batch_scope returned no
scope, so STEP.EXECUTE was checked with an empty scope in the IPC and container commands), 2 (plant.batch_facts,
open_container and batch_scope still read the test package, so GMP batches were refused in the plant commands), 3 (GMP
command evidence must not carry a package hash; the server sends none).

| # | Severity | Finding | Where | For |
|---|---|---|---|---|
| 4 | Low | prepare_gmp_issue accepts an allocation made earlier by another person and checks only BATCH.ISSUE there; the TEST- check on the number runs at issue, not at planning (harmless: issue re-checks both) | recipe-core 0501 | Phase 4 (planning screens) |
| 5 | Medium | An operator whose STEP.EXECUTE grant is limited to a product cannot start a press or open a container: the equipment and container state transitions check the permission at site scope only (fails closed). Default: those transitions also evaluate the batch's product scope | recipe-core 0403, 0422 transitions | Slice 3 (press blocks) |

## Slice 2b open items (builder report, 10 October 2026)

- A released site lot is not yet exercised on GMP: no seeded GMP persona receives or releases lots (slice 5, ERP stub
  and LIMS-lite seed them).
- Weighing on GMP (devices, readings) is not exercised end to end (slice 3, dispensing blocks).
- The running-batch routes keep their `/api/test-runs/*` paths on GMP; renaming them is screen work (slice 6).
- GMP batch planning needs `EBMR_NUMBER_LEDGER_FILE` for the protected number ledger; without it planning is refused
  with NUMBERING_NOT_CONFIGURED (deployment configuration, documented with the server settings).
