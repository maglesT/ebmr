-- The retest of a material lot is a signed act only (Phase 3 slice 6a, review of 0760; controls PR-18, DI-35, DI-17).
--
-- 0760 added site.record_signed_lot_retest (the QC person's own LOT_RETEST_APPROVED signature on the lot, then the rules of
-- 0752) but left site.record_lot_retest (0752) executable by the application role, so a retest could be recorded without
-- a signature. The unsigned writer is now the owner's only: the application role (and public) lose EXECUTE on it, and
-- the signed writer, a SECURITY DEFINER function owned by the owner, calls it after its signature and permission checks.
-- Nothing else changes.

set local role ebmr_owner;

revoke execute on function site.record_lot_retest(uuid, timestamptz, uuid[]) from public;
revoke execute on function site.record_lot_retest(uuid, timestamptz, uuid[]) from ebmr_app;

reset role;
