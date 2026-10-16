# Phase 6 review backlog

The residuals of the Phase 6 exit review (slice 6j-c, 16 October 2026; one pass, decision 0008). Each has a full entry,
with what was checked, in the "6j-c review" subsection of [phase-6-plan.md](phase-6-plan.md). The residuals of the
slice quick reviews (R-6a to R-6i) are in each slice's section of the same plan.

Fixed: 6jc-R1 (high; DI-14, DI-20): the ERP/WMS adapter's identity could record a person's material act (site services
0990), and 6jc-R8 (high, raised by the lead; DI-31): a small-order Ed25519 key made every seal under it verify (kernel 1230).
Both are in the [defect log](../../handbook/08-defect-log.md).

Backlog for the owner:
- Medium (IN-53, draft) 6jc-R2: the controlled-substance list and register reads need only a session.
- Medium (DI-31, owner) 6jc-R9: the adapter feed protocol and the gateway's OPC UA feed do not authenticate the source.
  Before a networked deployment: sign the gateway feed with the gateway key, or require mutual TLS.
- Medium (PR-27) 6jc-R10: the penicillin facility rule and the beta-lactam classification are set by one master-data
  steward, with no QA approval.
- Low (IN-30) 6jc-R3: the contract giver reviewer's scope is not enforced in `tab.record_read_problem`.
- Low 6jc-R4: migrations were merged out of numeric order. Suggested: a CI check that a new migration sorts after main.
- Low 6jc-R5: `site.erp_outbound_message` has no insert-only trigger.
- Low (DI-18) 6jc-R6: the DSC enrolment and the DSC record do not call `iam.assert_not_administrator()`.
- Low 6jc-R7: the authorization meta scans do not cover the `plant`, `tab`, `iam`, `esig` and `sandbox` schemas.
- Low (DI-31) 6jc-R11: an operator's acknowledgment of a sequence-gap alarm lets a blocking mirror be marked fresh.
- Low 6jc-R12: the mock recall treats a failed forward read as "no destinations", and it asks peers before the
  permission check.
- Low (DI-32) 6jc-R13: the gateway sets a missing OPC UA timestamp to epoch 0; there is no lower bound on source time.
- Low (IN-10) 6jc-R14: the companion signature never records a DSC (it fails closed).
- Low 6jc-R15: the training attempt read does not check whose attempt it is (sandbox only).
