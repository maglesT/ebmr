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
| P7A-1 | high (IN-53, draft) | Controlled-substance entries were readable through the audit-trail viewer: the controlled chains fell to the governance class, custody rows sat in lot chains and checkpoint rows in batch chains, open to any record reader. | Fixed (tablets 1415): the four controlled chain kinds need CONTROLLED.READ in scope to be read, listed, counted or verified; controlled tables' entries on lot and batch chains are hidden from other readers; QA still sees everything. Limit: a lot or batch chain's length and verification still count the hidden entries (that entries exist, not what they say). |
| P7A-2 | low | Four controlled write routes read back through the gated reads, so a writer without CONTROLLED.READ in that scope would get a refusal after a committed write. | Fixed (server): the read-back runs inside the write's transaction, so a refused writer gets 403 and nothing is committed. |
| P7A-3 | low | The register extract list had no site filter. | Fixed (tablets 1415): extracts carry no site and cover every site's lots, so they are read only with a grant without a site or product limit, the scope the export runs in. |
| P7A-4 | low-medium (DI-31) | The signature does not name the adapter: two OPC UA adapters bound to one gateway could replay each other's signed envelopes. | Fixed (tablets 1406): one live binding per gateway; a second adapter is refused (EBMR-DEV-179). The test failed before the fix. |
| P7A-5 | low (DI-31) | `transport_peer` comes from a session setting any application session can set. | Fixed (kernel 1306): the column already took only 64-hex values; its comment, the handbook and the runbook say it is advisory, recorded by the server's adapter worker, not evidence by itself. |
| P7A-6 | low (DI-31) | The v1 feed signature does not cover the envelope's `sourceTimestamp` and `sourceRecordId`. | Residual (lead): the receive functions take every GMP time from the payload, which the signed payload hash covers; the two envelope fields are stored metadata. The v1 format was fixed in 7-0 and stays; a v2 that adds them is an option for a later release. |
| P7A-7 | high (DI-47; regression from 1214) | Revoking the application role's SELECT on the controlled tables broke every true copy of a batch, lot or controlled product (the builder reads every registered table of the chain as the application role), so archiving and disposal failed (review/f34). | Fixed (recipe-core 1215): the application role, the server's own identity, reads the tables as it reads all GMP data, so true copies and archives stay complete; IN-53's database gate stays on every person-facing path (the gated definers of tablets 1413 to 1415, the audit viewer) and the routes; the old read functions stay closed to it. |

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

## Slice 7b-1 (the hardening list; review of 18 October 2026)

Built in two parts (7b-1a database and access items, 7b-1b worker, gateway and message items). One read-only pass for
bypasses, dropped checks in re-created functions, definer hardening, silent data loss and the "saved" answer. Checked
without a finding: the gap-alarm acknowledgment (kernel 1320), the DSC functions (1321), the insert-only outbound table
(site-services 1110), the restricted analytics counts (1322), every re-created function (only the intended lines
changed), `set search_path` and the administrator check first in every new definer, SAVED_NOT_SHOWN answered only after
a committed command.

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7B1-1 | medium (DI-32) | The 5-minute lower bound on OPC UA source times (recipe-core 1233) also refused alarms and equipment events that happened while the gateway was down and arrived at reconnect, and (found by GB-T-03) the current value of a tag that never changes, which an OPC UA server sends dated at its last change. | Fixed (kernel 1330, recipe-core 1234, 1235): series, alarms and events are refused only when older than the session start minus the gateway's offline buffer (`integration.opcua_offline_buffer_s`, default 7 days, change-controlled); a 1970 time is still refused; the gateway uses the same window. The round-2 fix came from the golden run. |
| P7B1-2 | medium (IN-30) | The contract-giver reviewer was refused only by `tab.record_read_problem`; the audit-trail reads granted on RECORD.READ, so its session read any batch's audit chain at database level. | Fixed (tablets 1426): every audit-trail read refuses the contract giver's reviewer at database level; QA still reads. |
| P7B1-3 | low-medium (DI-32, DI-31) | The gateway spool could lose samples without a SERIES_GAP: a crash just after a chunk closed, a spooled chunk failing validation, and a signing error that let the spool be truncated. | Fixed (gateway): the gap starts at the series' last journalled chunk end; dropped chunks are reported as a gap; the spool is truncated only when every recovery publish succeeded. |
| P7B1-4 | low (DI-32) | An endpoint session reported with a gateway clock near 1970 made the lower bound near 0. | Fixed (recipe-core 1234): a session is refused when it starts more than the offline buffer before the database clock (not 5 minutes: a server outage would otherwise refuse the sessions pulled after it). |
| P7B1-5 | low | The slow tag's baseline sample was dropped at every reconnect. | Settled by P7B1-1's fix (the window is the offline buffer). |
| P7B1-6 | low (DI-31) | A reconciliation whose commit succeeded but whose follow-up read failed was reported again on the next run. | Fixed (adapter framework): the result is read in the same statement as the insert. |

Residuals of the parts:
- F-6jb-g1 (medium, fail-safe): a record lock still counts as a change since review; the epoch rows carry no cause and
  the lock's bump shares `record_lock_append` with amendment and reconciliation bumps, so it cannot be told apart
  without loosening other change detection (D-P7-7; defect log).
- Ten writers refuse administrators just after their permission check rather than before (both before anything is
  written); listed by the wider authorization scan (6jc-R7), not re-created.
