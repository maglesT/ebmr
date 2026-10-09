-- Tablets edition, module C1: the application role learns nothing of a data-integrity investigation from what blocks
-- a record's release or disposal (Phase 2 exit review F34, round 3; DI-17, DI-50; Annex 11 and Part 11 limit access
-- to authorised persons; telling the person investigated can compromise the investigation).
--
-- Tablets 0410 and 0430 took the investigation tables and the retention holds away from the application role, but the
-- kernel's readers of what blocks a record (kernel 0440, SECURITY DEFINER) still ran for it with no session token:
--  - records.open_blockers(<type>, <id>) returned, for any record, every open investigation that blocks it with its id,
--    reference and the whole concern text, and every hold with its id and reason ("data-integrity investigation
--    DII-..."); called on each account the application role lists from iam.account, it named every person under
--    investigation and the concern;
--  - records.has_disposition_blockers answered the same question yes or no;
--  - records.disposal_refusals and records.retention_of named the blocking investigation of any record with a
--    retention schedule ("DI_INVESTIGATION DII-... blocks disposal");
--  - records.blocker_epoch, and records.lock_blocker_epoch which returns its counter, showed which records' blockers
--    changed and when, the account of the person investigated among them (the investigation holds it);
--  - records.retention_current says whether a record is on hold (it reads records.active_hold as the owner).
-- No screen, handler or command of this installation, and no recipe-core function, calls them as the application role:
-- the release module that will read the blockers comes in a later phase and reads them through a session-checked
-- function (default F34.1, docs/decisions/phase-2-open-questions.md). Now the application role (GMP; the sandbox role
-- follows through sandbox.mirror_application_privileges) executes none of these functions and selects neither
-- relation; the owner's tools and the kernel's own SECURITY DEFINER code (approval and purge of a disposal, the
-- disposal's signing content) still run them.

set local role ebmr_owner;

-- DI-17, DI-50 (F34): what blocks a record, its retention status and its blocker counter.
revoke execute on function records.open_blockers(text, text), records.has_disposition_blockers(text, text),
                           records.disposal_refusals(uuid), records.retention_of(text, text), records.lock_blocker_epoch(text, text)
  from ebmr_app;
revoke select on records.blocker_epoch, records.retention_current from ebmr_app;

reset role;
