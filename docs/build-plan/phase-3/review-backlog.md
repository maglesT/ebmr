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

## Slice 3a quick review (10 October 2026)

One high (recipe-core re-created the kernel's platform authority function; replaced by a kernel SCOPE hook, ADR 0018)
and three mediums (a setpoint read-back not tied to its download; alarm acknowledgement outside any step; a G-09@2 entry
not tied to the unit class of its equipment reference), all fixed in 3a.

| # | Severity | Finding | Where | For |
|---|---|---|---|---|
| 5 | Medium | A process device bound to a step is not linked to the `plant.equipment` unit of the step's equipment use | tablets 0820, recipe-core 0403 | Slice 3c (with container press codes) |
| 6 | Low | The plant transition scope of a unit uses the product of its latest use; a step.execute transition other than START_USE and END_USE on a unit last used for another product is refused for a product-limited grant (fails closed) | recipe-core 0522 | Slice 3c |
| 7 | Low | No server job records INTERFACE_LOSS automatically; G-06 is not yet wired into the client intents and screens; the demo gateway configuration has no press or coater | tablets server | Slice 3c (job), slice 6 (screens, demo) |

## Slice 3b open items (builder reports, 10 October 2026)

- GMP weighing through gateway device readings and GMP verification are not exercised: the GMP seed has no gateway
  identity or verifier persona (slice 6, demo seed). GMP manual weighing on a room balance is exercised.
- The lot assay approval workflow waits for LIMS-lite (slice 5); `tab.lot_assay_result` takes approved results now.
- TB-01: batch-size scaling, the balance minimum-weight rule, TB-01's computed items in the validator, TB-01 in the
  designer palette (slice 3c or 6).
- Granulation entry kinds are not in the api-contract `ClientEntry` yet (screens, slice 6); the tests write past the
  server as 3a did.
- No screen or filter-bag register in the plant schema: bag and screen data are the operator's declaration (slice 3c
  with tooling custody).
- No granulator, dryer or blender simulator; the gateway's device configuration accepts press and coater only (slice 6
  demo).
- Not modelled: TB-03 flameproof-area and stirring checks; the link from the TB-05 moisture analyser to its instrument
  check (slice 3c).

## Slice 3b quick review (10 October 2026)

No critical or high findings. The four replaced recipe-core functions (weighing_item_problem, new_container_problem,
refusal_problem, weighing_totals_problem) were diffed against their previous definitions: only the intended changes.
Fixed in 3b: 1 (TB-01's tolerance, adjustment-cap and FEFO exceptions were raised by the handler only; the database now
requires them), 2 (a weighing re-verifies that each calculation lot's assay is still current), 3 (TB-01 to TB-07 cannot
be skipped), 4 (a filter bag last used for another product cannot skip its wash record), 5 (duplicate lots and loose
compensation configuration refused), 6 (a null unit no longer bypasses the granulation unit check).

## Slice 3c open items (builder reports, 10 October 2026)

- **For the owner and the expert:** the compendial rule-set values in `tab.compendial_rule_set` (tablets 0890; weight
  variation, friability, disintegration, by pharmacopoeia) were taken from secondary sources and must be checked against
  the current official texts before validation. Each row carries its source and a confidence field for that review.
  The QA verification record of a rule set (design doc E.1) is not modelled yet (Phase 4, with review and release).
- Device-backed IPC values are proven for the balance only; there is no hardness, friability or disintegration tester
  simulator (slice 6 demo).
- The IPC and compression entry kinds are not in the api-contract (screens, slice 6).
- Tooling, detector and plant units are set up directly in the test databases (master-data screens, slice 6).

## Slice 3c quick review (10 October 2026)

No critical or high findings. The replaced functions (record_ipc_check, apply_hold, configure_press_discharge,
open_container, transition_scope, skip_problem, reading_use_purpose_check) were diffed against their previous
definitions: only the intended changes. The 0540 close and hold race fix was walked through every lock ordering.
Fixed in 3c: 1 (the tooling stroke limit was not enforced during the run and a returned set could still start a run;
output past the limit is now held), 2 (strokes could be undercounted without a baseline reading), 3 (standalone
TB-12 to TB-15 checks held nothing), 4 (a missed check now holds at once instead of at the next entry), 5 (a batch
market without a rule set fails closed; counts and sample sizes taken across all sets; friability repeats reuse the
first run's sets).
- **For the owner and the expert:** weight mode e (subdivision of scored tablets) has no Indian Pharmacopoeia rule set
  in `tab.compendial_rule_set`, so with the fail-closed rule (review 5) it cannot be used until the expert adds the IP
  rule set or records it as not applicable in `tab.compendial_not_applicable`. Likewise a sugar-coated batch that opts
  into the legacy in-house table is refused until its rule set is confirmed. Default until then: refused.
- A missed check recorded by the sweeper makes closed containers unusable at once (under a hold), but their status moves to HELD only at the next person's check, because the HOLD transition needs STEP.EXECUTE, which the sweeper deliberately lacks (least privilege). Accepted: unusable is the safety property.

## Slice 3d open items (builder reports, 10 October 2026)

- **For the owner and the expert:** the AQL table values (TB-20, tablets 0911) have medium confidence and must be
  checked against the current ISO 2859-1 text, especially the tightened-inspection table.
- **For the owner:** the TB-19 print approval gate is signed by QA (the hold-point signature needs QA.FLOOR_APPROVE). A
  QC-unit signature for this gate would need a new signature meaning in the kernel catalogue; default kept: QA.
- TB-18 and TB-20 sample weights are keyed by hand with a second person; balance capture is not wired (slice 6).
- A G-23 destruction entry in a test run cannot name a plant container label (sandbox identifier rule), so the
  destroyed-for-every-reject rule is proven on a forged state only (revisit with the GMP demo in slice 6).
- TB-06: ribbon checks keyed by hand (no instrument), FEED names no container charge, no stoppage handling (a long stop
  shows as a missed check), no roller-compactor simulator (slice 6).
- The new entry kinds of 3d are not in the api-contract (screens, slice 6).

## Slice 3d quick review (10 October 2026)

No critical or high findings. The replaced shared functions (ipc_pass_check, ipc_overdue_at, record_ipc_overdue,
granulation_block_item) keep every slice 3c fix; the AQL tables were cross-checked by hand at AQL 1.0 to 4.0.
Fixed in 3d: 1 (the out-of-limits and setpoint-mismatch exceptions of G-06 values were not required by the database for
TB-18; now one shared check for every block with G-06 entries), 2 (the reject destruction step's order and completion
are enforced), and the lows on yield rounding before the limit test, the constraint rebuild pattern and AQL severity
under concurrent batches.

| # | Severity | Finding | Where | For |
|---|---|---|---|---|
| 3 | Low | A lot with fewer than 2 accepted tablets gives no AQL plan (TB20-NO-PLAN) and can only leave through a deviation path | tablets 0911 | Slice 5 (deviation-lite) |
| 4 | Low | Not verified: whether a container opened on the printer before PRINT_SETUP is gated (the gate keys on the setup's printer) | tablets 0912 | Slice 6 (GB-T-01 run) |
