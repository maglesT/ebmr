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

## Slice 4a quick review (10 October 2026)

Two high (a gateway FAIL challenge could be dropped and a stale PASS reused; an export pack could be issued without
artwork for its own market), four medium (the serial report not checked against the recorded events; the L-29 hold
skipped without a unit and on a late acknowledgement; reconciliation counts not compared with the printer's counts; MRP
typed without a second person) and two low (print event sequence and job ownership; a parent batch aborted or rejected).
All fixed in 4a. Verified sound: limits computed by the database, coded surplus only destroyed, variable data from the
record, gateway scoping and idempotent acknowledgements, entry_block_problem diffed clean.

Decision recorded: the record keeps the L3 report hash as a reference and the counts, never unit serials (L-53); the
hash itself cannot be recomputed by the server, so the database checks the counts against the recorded serial events.

Open for the owner and the expert: the India Schedule H2 QR payload layout is a stub (`KEY=value;...`) until its data
elements are confirmed; it must be checked before validation.

## Slice 4b open items (builder reports, 10 October 2026)

- TB-21 pocket rejects feed TB-21's own blister count, not G-21's foil reconciliation; linking them needs a G-21 change
  beyond its configuration (slice 6, with the GB-T-01 packaging run).
- TB-21 defect checks are not scheduled (only the last must pass); TB-21 and TB-22 reel changes are not cross-checked.
- TB-23/TB-24 devices and the TB-22 leak tester are manual with two persons; no gateway link (slice 6 demo devices).
- No HTTP route for the SSCC register and the 4b entry kinds are not in the api-contract (screens, slice 6).
- Not done: the G-21 label "used" count against TB-23 good output; a maximum hold time for bright stock; bright stock
  across orders; refusing a PACKAGING order whose MBR has no TB-24 (Phase 4, with the release model).

## Slice 4b quick review (10 October 2026)

No critical or high findings. Two core mediums were fixed in this slice, each with a regression test: TB-23/TB-24 now
check line clearance, occupancy, artwork and isolation in the database; the sweeper now holds output for missed
TB-23/TB-24 line checks and device challenges.

Backlog (low):
- TB-21 isolation takes the beta-lactam flag from the MBR step config only, and coated products are exempt; take
  beta-lactam from product master data when it exists (slice 5 master data).
- "One part shipper" is enforced per TB-24 step, not per batch; a batch with two TB-24 steps could carry two.
- Reel release and expiry are checked at entry only; a reel quarantined mid-run is not caught (Phase 4, lot status
  events).

## Slice 5b open items (builder report, 11 October 2026)

- TB-20 NO-PLAN through a deviation (slice 3d #3) is not built: TB-20@1 needs an AQL result before it is performed,
  so the path needs a change-path extension; it stays fail-safe (the lot cannot leave) until then (slice 6).
- No HTTP routes or api-contract entries for TB-08 and G-24@2, and no server-side resolution of TB-08 source facts
  (the database re-reads them; screens in slice 6).
- The G-24@1 GMP refusal is proven on the function only; on GMP a G-24@1 step cannot start at all (0330, 0345).
- Defaults: per-use QA authorisation is the QA confirmation of the expiry cap (IN-19 (b)); the addition percentage is
  of the MBR's first batch size; REPROCESSING.AUTHORISE goes to QA_SHOP_FLOOR and AUTHORISED_PERSON.

## Slice 5 quick review (11 October 2026)

Every replaced function was rebuilt from its latest definition with no guard lost. Three high findings, fixed with
regression tests in this slice: the forward trace now includes whole-batch children (INV-33, PR-57); the printed
expiry cap now covers whole-batch parents (IN-19 (b)); a failing lot is resolved only by a confirmed laboratory error
with an approved passing replacement (IN-20). Core mediums fixed in this slice: whole-batch parent state, no chaining
and one request per parent; the charge lock on source containers; a STEP authorisation used once; the person who
records a deviation finding cannot conclude or close it (PR-50).

Backlog (medium and low):
- Evidence documents are self-attested (hash and storage key typed by the storer); tie them to stored bytes with a
  document service (Phase 4, document control).
- A LIMS revision can turn FAIL into PASS with a reason only; the recorder types the limits. Limits should come from
  an approved specification and a revision of a RELEASE result should require an OOS link (Phase 4, specifications).
- A lot with no LIMS results passes the LIMS release check (Phase 4, release model with required tests per material).
- The latest QC extra-testing decision wins, and nothing checks that the extra tests were run (Phase 4 release gate,
  which also wires `recipe.reprocessing_release_problem`).
- Low: the container lock assumes READ COMMITTED; raw unique-violation text on a concurrent ERP order reuse; ERP
  order_no not unique on the ERP side; an order stays consumed if its batch is cancelled; a RETEST-purpose result is
  accepted as an assay source.
- Whole-batch parents are checked by execution status (EXECUTION_COMPLETE or ABORTED) only; a REJECTED disposition
  check waits for the Phase 4 disposition model.

## Slice 6c open items (builder report, 11 October 2026)

- TB-20 NO-PLAN through deviation-lite needs a TB-20@2 (block data schemas are fixed per version); Phase 4.
- A packaging family's identity has no pack type, so two pack types of one product at the same pack size cannot both
  exist (recipe-core 0110); Phase 4 with the release model.
- The GMP sweeper does not run: its identity is TEST-only; a GMP service identity for the sweeper is needed before any
  GMP demo that relies on missed-check holds (Phase 4).
- `db-guards-free-text-shown` failed once under load and passed alone (suspected chance match of '2409' in generated
  text); root cause to find before the Phase 3 exit run.
- IN-17 "release is blocked" and IN-39 "both departments notified" re-deferred to Phase 4 (D-S6-10).

## Slice 6 quick review (11 October 2026)

Three high findings, fixed in this slice with regression tests: the formula composition was readable through the
e-signature content route by a role without FORMULA.READ (DI-13), also for a pinned MBR's BOM; the signed lot retest
did not bind its date and results, could reuse one signature, and the unsigned writer stayed granted to the app role;
FRESH_ON_SHARED (INV-40) was missing on lot receipt, evidence registration, formula creation and plant definitions.
Core mediums fixed: nested server-filled members, the product scope of formula reads, the lot REJECT meaning from
ON_HOLD, the MBR pin guard as the app role, a permission check on planning orders.

Open items from the builders (slice 6a and 6b):
- The success paths of the reprocessing acts and of an approved void are tested in the database but not over HTTP
  (GMP residue data needed); the refusals are tested over HTTP.
- No routes for the plant product list, a planned batch, or cleanings in progress (the screens accept a scanned id).
- The DI-24 browser test serves the step's reads from the contract example; the session and the no-delete check are
  the real server's.
- Display-only role hiding in the web (`app/roles.ts`); the server decides every act.
- A duplicate formula (same product, strength and batch size) answers 500 instead of a plain refusal (low).
- Default (6a review fix): REGULATORY_SIGNER holds FORMULA.READ, so the regulatory signer can read the MBR content it
  confirms.

## Slice 6d GB-T-01 (builder report, 11 October 2026)

GB-T-01 runs end to end over HTTP and matches `expected.json` exactly (16 golden tests: a source batch, then the happy
and exception-rich variants to "release for packing"; every worksheet quantity and yield; the 9.1 sample-data
negatives). Seven defects found by the run were fixed with tests (base-stated formula for TB-01, MBR transition
signing, G-09@2 instrument use, G-09@2/G-10@2/G-23@1 entries and loop/alternative intents over HTTP, hardness alias and
pressure units, TB-01 hydrate checks, golden CI job one file at a time).

Open for the owner:
- A drying-loop LOD reading that made the loop repeat (4.1 %) is not a failing result (loop readings are excluded by
  design), so its correction to 3.0 % without evidence was accepted in the database. CORRECT_ENTRY is not on HTTP in
  Phase 3, so it cannot happen today. Should a loop reading that did not meet the endpoint count as failing for the
  correction-evidence rule? Phase 4 slice 1a took the default (yes, stricter: D-1a-6, recipe-core 0716): such a
  correction needs a stored evidence document and QA approval whatever the new value; CORRECT_ENTRY is on HTTP now.
  The owner may still change it.

Residuals (Phase 4 unless noted):
- No HTTP routes yet for the change record, verification evidence, market authorisation, the batch-number rule,
  reservations, equipment uses, containers, tooling, the reprocessing proposal and container release; GB-T-01's driver
  does these through the database as the right persona.
- Press and coater readings cannot reach entries over HTTP, so they are keyed by hand (the manual-entry alerts appear
  in the happy variant); the device-to-entry path is Phase 4.
- Fixed in slice 6: a TB-18 pan load is refused while a compression container of the batch is on hold (tablets
  1092); a GMP G-07 weighing consumes its lot, and a row without it is refused (tablets 1093).
- Low: a TB-08 refusal repeats its code; a refusal says "test run" on GMP.

## Phase 3 exit review (Opus, 11 October 2026)

No critical findings. Five high: HIGH-1 (ERP master data writable by any interface identity, no QA confirmation),
HIGH-2 (a lot decision signature does not bind the event), HIGH-3 (a packaging order skips "release for packing" and
the container holds: no bulk issue), HIGH-4 (orphan consumption: `recipe.consume_lot` checks no batch state or entry)
are fixed on the exit branch with their tests. HIGH-5 (generic-block guards in the Tablets edition) is decided by
ADR-0019: moved to recipe-core before Phase 5. The press counter compared as a JavaScript number (tb-11) is fixed.

Backlog (medium):
- `plant.close_container` takes a typed net quantity with no weighing or second person; no route calls it yet
  (Phase 4, with container routes).
- The output container release is not tied to the state of its hold's exception or deviation; the Phase 4 release
  gate checks it.
- The GMP sweeper does not run (already listed): missed-check holds on GMP depend on the next manual entry.
- Performance: each `recipe.execution_state` change runs about 50 triggers, many re-parsing the MBR JSON (GB-T-01 takes
  about 20 minutes); measure before the Phase 4 golden batches.

Exit fixes (branch phase-3/exit-fix): ERP master writes need ERP.MASTER_WRITE (ERP_INTERFACE only) and safety-relevant
changes (new code, shelf life, reprocessing permission, material kind, retest interval, beta-lactam) take effect only
after a QA-signed ERP_MASTER_CONFIRMED; lot decisions are proposed first and the signature binds the event; a packaging
order needs a bulk issue of usable containers after H-PACK before TB-21, TB-23 or TB-24 entries on GMP; consumption
needs an ISSUED or IN_PROGRESS batch and an entry of the same command, and reservations are revoked at batch end.
Residuals: no screen for the bulk issue and no HTTP route to plan a packaging order (Phase 4); packing steps inside a
GMP processing batch are refused (stricter default); over HTTP a lot decision is still RELEASE or REJECT only, and
HOLD, UNHOLD, RETURN and RECALL need the propose step on that path when they are exposed (Phase 4).

## Phase 3 exit, TypeScript mutation (Opus, 11 October 2026)

Calculations (potency, IPC, coating, AQL), block entries, G-06, the status blocks, signing content and data rules meet
90 %; the other tablet blocks meet 80 %. Five high-risk blocks end between 84 and 90 % (TB-15 89.6, TB-11 88.0, TB-12
86.3, TB-18 86.0, TB-01 84.5), G-21 at 88.4; their remaining survivors are listed by file in the exit branch's commits
(mostly simulator nominal entries and refusal texts). No critical or high defect.

Backlog:
- Medium: TB-11, a start sweep marked missed stays due, so every later entry raises IPC_CHECK_MISSED again.
- Medium, for the owner and the expert: TB-12 subdivision can never be recorded, because India is in every market set
  and has no rule set (or not-applicable record) for subdivision; decide the India rule before validation.
- Medium: site-services 0733 sorts test codes without `collate "C"` (0762 uses it); on another database collation the
  QC extra-testing decision can become unsignable (fails safe).
- Low: the TB-15 MBR acid time is not bounded by the rule set; the TB-06 recycle message says "above zero" but zero
  passes; an anhydrous molar mass is not checked against the base.
- Residuals (lower risk, listed not tested): simulator nominal entries, refusal texts, route wiring and views, thin
  TypeScript wrappers over SQL (covered by the SQL stream).

## Phase 3 exit, SQL mutation (Opus, 11 October 2026)

14,544 mutants in 60 groups. At or above 90 %: every Phase 2 group (99 to 100, involvement 95.7, weighing 96.9) and the
Phase 3 groups for signed content, evidence, formulas, plant equipment, ERP interfaces, deviations, entry references,
output containers, TB-01 dispensing and platform scope. Kill tests cover the core: holds and release gates (press
output, blister, bottle line, release for packing, bulk issue), forged GMP issue and planning, TB-01 rounding and FEFO,
IPC and AQL verdicts, G-21 counts, reprocessing limits and signers, approver roles and signed retests. 195 equivalent
mutants recorded with reasons. No critical or high defect.

Below 90 % (residuals for the owner, Phase 4 exit or deployment validation per decision 0008): reprocessing 85.6,
lots and LIMS 80.9, tablets core checks 75.2, blister 75.0, coating 70.6, G-21 68.8, forming 67.6, bottle 65.4,
compression 65.3, printing and serialisation 60.6, tablets IPC 58.4, process devices 56.9, granulation 55.7; GMP batch
issue and change paths re-running with new kill tests. Most survivors are in the database twins of the engine's entry
and close checks (the engine validates first; the database re-checks against tampering). Not twins, and to be covered
first in Phase 4: G-07 consumption pairing, lot-material entry checks, tooling register commands, detector
challenges, the print, serialisation and process-device gateway checks, the due-time functions (IPC, leak, packing
line), the held-granulation check, G-24@2 and the exception-register sync guards.

Low: `recipe.reprocessing_start_problem` is never called since recipe-core 0625 (drop it); `batch_record_identity_guard`
and a SITE-165 branch of `consume_reservation` can never fire (an earlier check refuses first).

## Ticked in Phase 4 slice 1b (12 October 2026, branch phase-4/slice-1b)

- GMP sweeper (slice 6c, exit review): the GMP service identity svc.sweeper on SRV-SWEEPER-01, EXECUTION_SWEEPER only
  (D-P4-9); the GMP server reads it from gmp-service-keys.json. The "unusable under hold" design stays.
- `plant.close_container` typed net (exit review medium): a typed close needs a second person's VERIFIED check before
  use or release (recipe-core 0740, DI-30); a weighed close stands on two claimed scale readings (tablets 1111). Container
  routes: contract ns/containers.ts, signable CONTAINER_ACT (tablets 1112).
- Output container release vs its hold (exit review medium): refused while the hold's exceptions are open or a linked
  deviation is not concluded, and while the sweeper's MISSED hold is not yet recorded on its step (recipe-core 0741).
- Device-to-entry path (slice 6d residual): an EQUIPMENT entry names only its reading; the server claims it and copies the
  value (D-P4-10); the claim is limited to the step's window (tablets 1111). GB-T-01 still keys its coater values by hand.
- TB-20 NO-PLAN (slices 3d, 5b, 6c): TB-20@2 with the NO_PLAN outcome through a linked deviation (tablets 1113, D-P4-11).
- TB-11 missed start sweep stays due (mutation medium): fixed in tb-11.ts and tablets 1110.
- Site-services 0733 collation (mutation medium): `collate "C"` in site.qc_test_codes (site-services 0810).


## Ticked in Phase 4 slice 2c (12 October 2026, branch phase-4/slice-2c)

- Slice 2b #4 (low): `recipe.prepare_gmp_issue` takes a number allocated ahead only from the person who allocated it
  (EBMR-PLN-004) and checks the test-number rule at planning too (recipe-core 0761).
- Slice 4b: a PACKAGING order whose master has no TB-24 step is refused at planning (EBMR-PLN-005; the completion block
  per edition is recipe-core data, `recipe.packaging_completion_block`, tablets TB-24).
- Slice 6c: the packaging family's identity holds its pack type (D-P4-13; `recipe.mbr_family_pack`, recipe-core 0760).
- Exit residual: packaging orders are planned over HTTP (`POST /api/planning/packaging-orders`) and their bulk is issued
  from a screen (`/planning/packaging/$batchId`, over `POST /api/batches/:id/bulk`).

## Ticked in Phase 4 slice 2a (12 October 2026, branch phase-4/slice-2a)

- Evidence documents self-attested (slice 5 backlog): the database stores the bytes and computes the SHA-256 and the
  size (`site.store_evidence_document`, site-services 0823); the typed form is refused; a document is evidence only
  while its stored bytes match its hash. Residual: recipe-core 0601 and 0716 still look a correction's evidence up by
  hash in `site.evidence_document` directly, so a row stored before 0823 without bytes still matches there (call
  `site.evidence_document_verified` in a recipe-core migration of slice 2c or 3).

## Ticked in Phase 4 slice 2b (12 October 2026, branch phase-4/slice-2b)

- LIMS limits typed by the recorder (slice 5 review): limits, unit and method come from the approved specification in
  effect for the lot's material, which cites the pharmacopoeia and edition of every limit (IN-33; site-services 0840,
  0841); a revision of a RELEASE result cites the lot's OOS record, and a revised failure stands until that record
  concludes a confirmed laboratory error (IN-20).
- A lot with no LIMS results passed the release check (slice 5 review): every required test of the specification needs a
  current RELEASE result judged against it (PR-45; 0841).
- The latest QC extra-testing decision wins and nothing checks the tests were run (slice 5 review): a later decision keeps
  every earlier test, and `site.extra_testing_problem(batch, lot)` checks the tests against the lot's approved results
  (0841). Wiring it and `recipe.reprocessing_release_problem` into the release model stays with slice 3.
- Lot events over HTTP with the propose step (exit review, HIGH-2 follow-up): HOLD, UNHOLD, RETURN and RECALL are
  proposed (`POST /api/lots/:lotId/decisions`) and signed as LOT_DECISION (D-P4-3); a RECALL of a finished lot is refused
  on that path (0842).
- Reel quarantined mid-run (slice 4 review, low): the next person's entry of a running TB-21 run is refused while a reel
  on the machine is not released and unexpired (tablets 1151, EBMR-TAB-853).
