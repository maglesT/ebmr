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

## Gaps: controls left without `clauses`

7a writes no product code. A control with a clause that no test proves keeps no `clauses` mapping, so the trace at
phase 4 names it; its other clauses are proven by listed tests and get mapped once the gap closes.

**Closed by 7d (tests of behaviour that exists, 13 October 2026).** Now mapped in full: DI-07, DI-10, DI-25, DI-28,
IN-14, PR-12, PR-14, PR-30, PR-31, PR-44; the Phase 3 deferrals DI-24 clause 3 (review list) and PR-08 clause 2 (release
screen) now name their tests. Proven but not mappable while another clause is open: DI-09 clause 1, DI-26 clause 2,
PR-16 (the checker-signature half), PR-36 clause 1 (already proven by the listed G-21 print-job test), PR-46 clause 1.

| Control | Missing |
|---|---|
| DI-08 | feature: no vendor support account or customer-approved time-boxed support grant |
| DI-09 | feature: no configuration diff as of a past date |
| DI-26 | feature: review-by-exception rules are fixed in code; no editable rule with a change record |
| IN-01 | feature: no CAPA register with effectiveness checks (6c residual d) |
| IN-16 | 7b: GB-T-01 two blister orders from one bulk (D-P4-15) with start/mid/end coding specimens |
| IN-27 | feature: the designer's inserted PPE and decontamination steps (6a residual) |
| IN-30 | feature: the contract giver's read-only access (6a residual) |
| IN-31 | feature: no label template with its fields; the print data always carries the record's dates, so there is no template approval to fail (clause 1) |
| IN-33 | feature: the edition review lists specifications only; MBR limits citing an edition are a 2a residual |
| IN-39 | feature: only manufacturer release decisions reach the departments' notification centre; the excursion's notification is recorded in the run, never delivered (clause 2, Phase 3 deferral) |
| PR-09 | feature: typed CPP values (yields, IPC results) in the PQR extract are a 6c residual |
| PR-15 | feature: no area authorisation of persons (the filling suite itself is Injectables) |
| PR-16 | feature: no labelling-specimen item in the batch record checked at completion (specimens are checked on the master only, GMP-SPECIMENS) |
| PR-17 | feature: no receipt split per supplier batch, no approved-manufacturer register, and no complete receipt record (supplier and supplier lot optional; manufacturer, containers and examiner not recorded) checked before issue |
| PR-22 | 7b: the batch report (PDF) shows the unit IDs; the equipment status display after each transition |
| PR-25 | feature: rooms carry no clean-hold (only equipment classes do), so a room overdue for cleaning is not refused (clause 3) |
| PR-27 | feature: no facility-level penicillin refusal (packing-line isolation only, IN-38); no spill event on a room (clause 1 needs only a [PR-27] tag on the IN-27 line test) |
| PR-29 | feature: no reagent or buffer lot with an expiry at an IPC step |
| PR-32 | feature: no label store or label-store permission; printed material is issued at the G-21 step by its performer role, stock locations are the ERP's (clause 2) |
| PR-34 | feature: no post-use line inspection gating the close of a packaging order; the line clearance is recorded before the next order (clause 2) |
| PR-35 | feature: lines have no adjacency or segregation between them (clause 1); 7b: the line station display |
| PR-36 | feature: the vision check of a printed expiry is the device's (challenges record PASS/FAIL with a generic test unit) (clause 2); no cut-label option (clause 3) |
| PR-39 | feature: no reconciliation waiver for 100% electronic inspection |
| PR-46 | feature: no stock locations (ERP, Phase 6) (clause 2) |
| PR-49 | feature: no recurrence count or warning on the certification screen |
| PR-50 | feature: no deviation impact query returning the affected batches (genealogy explorer, Phase 6) (clause 2) |
| PR-51 | feature: no CAPA register (CAPA references only; 6c residual d) |
| PR-52 | feature: a review-by-exception reduction needs a risk class and rationale but no validation reference (clause 2) |
