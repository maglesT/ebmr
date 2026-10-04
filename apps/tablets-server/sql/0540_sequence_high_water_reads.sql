-- Tablets edition, module C1: the application role learns from no protected sequence when and how many data-integrity
-- investigations and retention holds were opened (Phase 2 exit follow-up F34, round 4, the verifier's item
-- HIGH-WATER; DI-17, DI-50; Annex 11 and Part 11 limit access to authorised persons; ADR 0012 item 9: the read rules
-- hold when the application's own database credentials are used directly).
--
-- Tablets 0410 to 0530 took the investigations, their holds and their audit chains away from the application role, but
-- two continuity readers of the kernel (0600) still served it, without a session, the numbers those records are given:
--  - continuity.sequence_high_water() (SECURITY DEFINER) returns the last value of every protected sequence, among them
--    records.di_investigation.investigation_no and records.retention_hold.hold_no (and records.incident.incident_no):
--    read now and again later, it told when and how many investigations and holds were opened, though not who;
--  - continuity.sequence_bump keeps, for each sequence a restore or the securing of identifiers moved, its value before
--    and after.
-- No screen, handler or command of this installation, and no recipe-core function, reads either as the application
-- role. The kernel's anchor job (exportAnchor, which copies the marks to the external ledger) and its start-up check
-- against the ledger also read kernel.audit_anchor, which is the owner's since tablets 0430, so on this installation
-- they run as the owner already. Now the application role (GMP; the sandbox role follows through
-- sandbox.mirror_application_privileges) executes the one and selects the other no more; the owner's tools, the
-- restore procedure (continuity.secure_identifiers and continuity.after_restore, SECURITY DEFINER, which answer the
-- moves to the restore operator holding CONTINUITY.RESTORE_OPERATE) and the kernel's own invariant check
-- (continuity.number_invariant_violations, which names a sequence key only when a counter went backwards) still do.
-- What the application role still reads of the continuity tables is listed in default F34.2.

set local role ebmr_owner;

-- DI-17, DI-50 (F34, HIGH-WATER): the high-water marks and moves of the protected sequences.
revoke execute on function continuity.sequence_high_water() from ebmr_app;
revoke select on continuity.sequence_bump from ebmr_app;

reset role;
