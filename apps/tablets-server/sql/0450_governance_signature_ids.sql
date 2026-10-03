-- Tablets edition, module C1: the application role finds no id of a GOVERNANCE-class signature or restore without a
-- session (Phase 2 exit review F34, round 2; DI-17, DI-50; Annex 11 and Part 11 limit access to authorised persons).
--
-- The kernel's esig.signature_state and esig.seal_payload answer, for a signature id the caller holds, who signed which
-- record with which meaning and when. The application role must keep them without a session: the MBR guards (recipe-core)
-- and the signing flow ask them inside commands. After tablets 0410 and 0430 hide every GOVERNANCE-class row of the
-- signatures and their side tables, the application role could still pick up such ids, and with them the signatures'
-- data, from:
--  - records.purge_approval and records.tombstone (the RECORD_DISPOSAL_APPROVED signature of each disposal);
--  - continuity.restore_event_approval (the RESTORE_APPROVED signatures), and continuity.restore_event and its status view,
--    which also name the chains a restore affected (data-integrity investigations' among them);
--  - esig.verify_signatures and esig.invariant_violations, which list every signature with a problem, of any class.
-- These are GOVERNANCE-class (retention, tombstones, restores: default F34.1 and F35.1); no screen or handler of this
-- installation reads them, and the kernel's functions that do are SECURITY DEFINER. Now the application role selects none
-- of the five relations and runs neither list; the owner's tools still do (default F34.2).

set local role ebmr_owner;

revoke select on records.purge_approval, records.tombstone, continuity.restore_event, continuity.restore_event_approval,
                 continuity.restore_event_status from ebmr_app;
revoke execute on function esig.verify_signatures(timestamptz), esig.invariant_violations() from ebmr_app;

reset role;
