-- Tablets edition, module C1: the application role reads no stored authority evaluation, so it learns from none when and
-- how many data-integrity investigations were opened, linked, refreshed and closed and legal holds placed and released,
-- nor which lead or QA reviewer acted (Phase 2 exit follow-up HIGH-WATER, round 4, lane round 3; DI-17, DI-50; Annex 11
-- and Part 11 limit access to authorised persons; ADR 0012 item 9: the read rules hold when the application's own
-- database credentials are used directly).
--
-- Correction of tablets 0540's and 0570's headers. 0540 said that once the protected sequences' high-water marks were
-- the owner's, the investigation and hold numbers told the application role neither when nor how many investigations
-- and holds were opened; 0570 said the same of PostgreSQL's table statistics, and named what was left as default HW.1.
-- Neither was the last door: kernel 0130 grants ebmr_app SELECT on iam.authority_evaluation, where iam.evaluate_authority
-- stores every permission check with its time, person, account, role and outcome, and the sandbox role followed through
-- sandbox.mirror_application_privileges. In the kernel VALIDATION.MANAGE is checked only by
-- records.open_di_investigation, link_di_investigation and refresh_di_investigation_scope, DI_INVESTIGATION.APPROVE_CLOSURE
-- only by records.close_di_investigation and by esig.sign for its DI_INVESTIGATION_CLOSED signature, and
-- RECORD.LEGAL_HOLD only by records.place_legal_hold and release_legal_hold. So, without a session, the application role
-- read when and how many investigations were opened, linked, refreshed and closed and legal holds placed and released,
-- and the person and account of the lead or QA reviewer who acted (not whom the investigation is about). Measured in a
-- fresh copy of each installation: the role read no such row before, and three VALIDATION.MANAGE rows after one opening,
-- one link and one refresh, two DI_INVESTIGATION.APPROVE_CLOSURE rows after the closure was signed and recorded, two
-- RECORD.LEGAL_HOLD rows after a legal hold was placed and released. A scan of every relation the role may select, its
-- readable sequences and its zero-argument functions, before and after each of those commands, found no other row that
-- changed with them but the authentication of the closure signing in iam.auth_event (whose signing request the role does
-- not see, so it tells that someone authenticated to sign a GOVERNANCE-class record, not which one), the sessions' last
-- activity and the installation-wide audit horizon (default HW.1).
--
-- Every reader of the table in the kernel and recipe-core is SECURITY DEFINER and runs as the owner
-- (iam.evaluate_authority, esig.sign, esig.signature_problems, esig.seal_payload, esig.evidence_package,
-- recipe.role_evaluation_problem, recipe.issue_execution); no handler, job or command of this server selects it, and no
-- view reads it. Now the application role (GMP; the sandbox role follows through sandbox.mirror_application_privileges)
-- selects no row or column of it. It still calls iam.evaluate_authority, which stores the evaluation and answers the caller
-- its own (the kernel's authorisation hook, the refusal log of a refused command, the signing flow), and the owner's tools
-- and the evidence package still read every evaluation. INV-26 (every evaluation stored, with its inputs) is unchanged.
-- What the application role still reads of the identity tables is owner residual F34.2. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-17, DI-50 (HIGH-WATER): the stored authority evaluations. A table-level REVOKE also takes any column privilege.
revoke select on iam.authority_evaluation from ebmr_app;

do $$
begin
  if pg_catalog.has_any_column_privilege('ebmr_app', 'iam.authority_evaluation', 'SELECT')
     or pg_catalog.has_any_column_privilege('public', 'iam.authority_evaluation', 'SELECT') then
    raise exception using errcode = 'P0001',
      message = 'The stored authority evaluations are still readable by the application role (DI-17, DI-50). [EBMR-TAB-023]';
  end if;
end
$$;

reset role;
