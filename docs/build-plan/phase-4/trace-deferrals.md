# Phase 4 trace: deferred clauses (for the owner)

Builder 7a, 12 October 2026. Every catalog-test clause of a phase-4 control that the build cannot test yet is deferred
in its control file (`clauses[].deferred`) with the phase and the reason; none is deferred silently (rule D-S6-10).
The owner may move any of them. The reasons are paraphrased here; the control files hold the full text.

## Deferred to Phase 5 (Injectables edition, built after Phase 7 per decision 0010)

| Control | Clause (short) | Why |
|---|---|---|
| PR-26 | scanning a hose to the wrong destination | liquid transfers are Injectables; Tablets uses labelled containers (IN-26, PR-21 tests) |
| PR-28 | failed autoclave cycle blocks issue of the load | sterilisation is Injectables only |
| PR-28 | open EM excursion on the QP screen | clean-area monitoring is Injectables only |

## Deferred to Phase 6 (integrations and extras)

| Control | Clause (short) | Why |
|---|---|---|
| IN-07 | list every input lot and customer shipment of a batch | shipments come from the ERP/WMS adapter; genealogy explorer |
| IN-10 | release signed with a DSC validates against the CCA chain | DSC/eSign provider after the legal opinion (open decision 3) |
| IN-29 | batches with recovered material from affected batches | chemical recovery not built (D-2b-6); genealogy explorer and mock recall |
| PR-42 | query a commissioned serial for lot, expiry, status | serial status is the L3 system's; L3/L4 adapters |
| PR-57 | seeded split/merge/rework scenario returns the nodes | genealogy explorer and mock recall (Phase 6 exit names PR-57) |
| PR-57 | forward trace lists every consignee, matching the ERP | consignees come from the ERP/WMS adapter |

## Deferred to Phase 7 (validation pack and hardening; plan slice 7: documentation-type controls)

| Control | Clause (short) | Why |
|---|---|---|
| DI-02 | export a batch and restore it into an isolated environment | restore drill |
| DI-03 | GMP batch refused on a release without a validation summary | validation summary is generated with the pack |
| DI-06 | drift alarm for an interface not in the approved description | system description and trace matrix of the pack |
| DI-06 | every critical limit shows boundary-test evidence in the matrix | trace matrix of the pack |
| DI-08 | full tenant export re-opens in the stand-alone viewer | stand-alone viewer, hosting documentation |
| DI-11 | periodic evaluation pack traced to source logs | periodic evaluation pack |
| DI-44 | periodic readability report | part of the periodic evaluation pack (DI-11) |
| DI-46 | upgrade the test environment, then retrieve and render | upgrade and restore drill |
| DI-48 | migration dry run | no legacy migration in the build; deployment validation |
| IN-09 | restore a backup to a test instance; a closed batch renders | restore drill |
| IN-12 | validation package with each artefact and the SMF paragraph | validation pack |
| PR-60 | AI feature inventory | no AI features; inventory document of the pack |

## Points for the owner and the lead

1. **A control with every clause deferred still needs a passing test.** The trace requires a passing tagged test for
   every due control. DI-06, DI-11, DI-48, IN-12, PR-28 and PR-60 have no test at all (every clause deferred), so the
   trace fails them at phase 4 until either a test proves some part of them or the owner decides how the gate treats a
   fully deferred control. DI-08, PR-15 and PR-51 also have no tagged test (each has a clause with no test, listed with the gaps).
2. **Deferrals to Phase 5 under decision 0010.** Phase 5 (Injectables) is built after Phases 6 and 7, but the trace
   counts a deferral to phase 5 as started once `current_phase` reaches 5. When Phase 6 raises the phase, the PR-26 and
   PR-28 deferrals above (shared controls, so still in the gate with `editions: [tablets]`) will fail unless the owner
   moves them or the tooling treats Phase 5 as not started while Injectables is outside the gate.
3. **The `editions` filter** (`compliance/phase.yaml`, decision 0010): the gate covers the Tablets edition; a control
   whose only edition is Injectables (91 controls, all target phase 5) is not due and its deferrals wait with the
   edition. Shared controls are always due. Tested by the `[meta]` tests in `tools/register/test/register.test.ts`.

## Gaps: controls left without `clauses` (no test proves a clause yet)

7a writes no product code. A control with a clause that no test proves keeps no `clauses` mapping, so the trace at
phase 4 names it; its other clauses are proven by listed tests and get mapped once the gap closes. Owner: 7b (golden
batches, browser), 7c (a kill test or a missing tag), or a feature not built (the owner decides: build, or defer with a
reason). Still open from the Phase 3 deferrals to phase 4: DI-24 clause 3 (the change and its original in the review
list; the PDF part is proven), IN-39 clause 2 (the pressure-excursion notification delivered to both departments),
PR-08 clause 2 (the registration flag on the release screen). The DI-12, DI-34, IN-17 and PR-07 deferrals now name
their passing tests.

| Control | Missing |
|---|---|
| DI-07 | 7c: no test refuses a criticality downgrade of a field without QA approval |
| DI-07 | 7c: the NON_CRITICAL correction test does not assert the audit trail and the review list |
| DI-08 | feature: no vendor support account or customer-approved time-boxed support grant |
| DI-09 | 7c: no DI-09 test that an administrator cannot change a specification limit |
| DI-09 | feature: no configuration diff as of a past date |
| DI-10 | 7c: no test that tightening a limit after completion leaves the completed record's limit version and verdict unchanged |
| DI-25 | 7c: no test that a value changed after entry appears in the checker's step view and the audit-trail review list (D-P4-16) |
| DI-25 | 7c: no test that no configuration defers the audit-trail review |
| DI-26 | 7c: no test that a clean batch's review shows no exceptions with its summary |
| DI-26 | feature: review-by-exception rules are fixed in code; no editable rule with a change record |
| DI-28 | 7c: no test that an out-of-limit value is committed (audit trail) before the warning |
| IN-01 | feature: no CAPA register with effectiveness checks (6c residual d) |
| IN-14 | 7c: no test that each pack size of a product needs its own approved packaging master (D-P4-13) |
| IN-16 | 7b: GB-T-01 two blister orders from one bulk (D-P4-15) with start/mid/end coding specimens |
| IN-27 | feature: the designer's inserted PPE and decontamination steps (6a residual) |
| IN-30 | feature: the contract giver's read-only access (6a residual) |
| IN-31 | 7c: no test that an India-domestic label template without a manufacturing-date field fails approval |
| IN-33 | feature: the edition review lists specifications only; MBR limits citing an edition are a 2a residual |
| PR-09 | feature: typed CPP values (yields, IPC results) in the PQR extract are a 6c residual |
| PR-12 | 7c: no test of correcting a signed weight (re-signature, exception-report listing), none for a correction without a reason tagged PR-12 |
| PR-14 | 7c: no validator test refusing single-person automated checking on a step outside its allowed scope |
| PR-15 | feature: no area authorisation of persons (the filling suite itself is Injectables) |
| PR-16 | 7c: no test that a missing label specimen or checker signature blocks completion naming the gap |
| PR-17 | feature: no receipt split per supplier batch and no approved-manufacturer register; 7c: a lot without a complete receipt record is not issued |
| PR-22 | 7b: the batch report (PDF) shows the unit IDs; the equipment status display after each transition |
| PR-25 | 7c: no test that a room past its clean-hold is refused (presses only) |
| PR-27 | 7c: no facility-level penicillin refusal (packing-line isolation only, IN-38); feature: no spill event on a room (clause 1 needs only a [PR-27] tag on the IN-27 line test) |
| PR-29 | feature: no reagent or buffer lot with an expiry at an IPC step |
| PR-30 | 7c: no test that a constraint's elapsed time survives a client and server restart |
| PR-31 | 7c: no test that the yield step needs its verifier, nor that an independent recalculation matches |
| PR-32 | 7c: no test that a person without the label-store permission cannot issue printed material |
| PR-34 | 7c: no test that a packaging order does not close without the post-use line inspection |
| PR-35 | 7c: no test of adjacent packaging lines; 7b: the line station display |
| PR-36 | 7c: a change of batch data after print set-up voids the job; a vision challenge with a wrong expiry; feature: no cut-label option |
| PR-39 | feature: no reconciliation waiver for 100% electronic inspection |
| PR-44 | 7c: no test that packaging completion (or G-REL) waits for the reserve sample |
| PR-46 | 7c: no test that a REJECTED lot cannot be dispensed; feature: no stock locations (ERP, Phase 6) |
| PR-49 | feature: no recurrence count or warning on the certification screen |
| PR-50 | 7c: no test of the deviation impact query against an independent query |
| PR-51 | feature: no CAPA register (CAPA references only; 6c residual d) |
| PR-52 | 7c: no test refusing review by exception on a step without a validation reference |
