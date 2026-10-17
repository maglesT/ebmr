# Phase 7 review backlog

The findings and residuals of the Phase 7 slice reviews (one quick review per slice, decision 0008; at most 2 fix
rounds per finding, then a residual). Fixed findings also have an entry in the
[defect log](../../handbook/08-defect-log.md).

## Slice 7a (the decision 0022 fixes; review of 17 October 2026)

One read-only pass over the merged slice (parts R9, R10, R2, R16) for bypasses, dropped checks in re-created
functions, definer hardening, the signature check and mutual TLS. Checked without a finding: the verification marker
(keyed on the transaction and the envelope hash, used once, granted to nobody), every `plant.receive_*` passing
through `platform.accept_inbound_detail`, proposer self-approval refused, the in-force plant-rule readers, every
re-created function only adding or narrowing checks (the alarm acknowledgment's unscoped check for batch-bound alarms
is replaced by the batch's scope, as intended), `set search_path` on every new definer, the key lookup bound to the
adapter's gateway, the payload checked against its hash on the raw text, the pinned CA and server name.

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7A-1 | high (IN-53, draft) | Controlled-substance entries were readable through the audit-trail viewer: the controlled chains fell to the governance class, custody rows sat in lot chains and checkpoint rows in batch chains, open to any record reader. | Fix round 1 (R2): the controlled chains need CONTROLLED.READ in scope; controlled tables' events are left out of lot and batch chains for other readers. |
| P7A-2 | low | Four controlled write routes read back through the gated reads, so a writer without CONTROLLED.READ in that scope would get a refusal after a committed write. | Fix round 1 (R2). |
| P7A-3 | low | The register extract list had no site filter. | Fix round 1 (R2): filtered, or the reason it is safe. |
| P7A-4 | low-medium (DI-31) | The signature does not name the adapter: two OPC UA adapters bound to one gateway could replay each other's signed envelopes. | Fix round 1 (R9): one adapter per gateway, with a test. |
| P7A-5 | low (DI-31) | `transport_peer` comes from a session setting any application session can set. | Fix round 1 (R9): advisory, 64-hex only, documented as not evidence by itself. |
| P7A-6 | low (DI-31) | The v1 feed signature does not cover the envelope's `sourceTimestamp` and `sourceRecordId`. | Residual (lead): the receive functions take every GMP time from the payload, which the signed payload hash covers; the two envelope fields are stored metadata. The v1 format was fixed in 7-0 and stays; a v2 that adds them is an option for a later release. |

Residuals of the parts (from the builders):
- R10: on upgrade, every earlier plant-rule version counts as a pending proposal: a material declassified before 7a
  stays beta-lactam until QA approves the declassification (stricter, intended).
- R9: a gateway journal written before 7a is refused (EBMR-INT-030); the runbook says to start with a fresh journal.
  The kernel test helper `receive()` delivers OPC UA envelopes through a TEST-ONLY verifier made in the test's own
  database (a deliberate test seam).
- R16: the hold-point proposal tests stop at the act's own state check (EBMR-EXE-084); a sandbox test run's issue and
  site consumption keep the stricter location or site scope (no order to give the product); the issuer's engine roles
  at a GMP issue stay location-only (BATCH_ISSUER maps no engine role).
- Lead: `recipe.check_engine_roles` stays in the `execution-commands` mutation group: recipe-core 1224 drops only its
  2-argument form; the 3-argument form remains and is mutated by name.
