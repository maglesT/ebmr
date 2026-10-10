-- Tablets server, module C3 on the GMP installation (Phase 3 slice 2b item 3; docs/build-plan/phase-3/slice-2b-plan.md):
-- the issuer signs a planned GMP batch's issue content with the meaning ISSUED through the server's ceremony
-- (controls DI-05, DI-17, DI-35, DI-37, INV-10).
--
-- recipe-core 0500 registers the e-signature aggregate batch_issue (recipe.batch_issue_content: the batch number and its
-- register allocation, the family and product, the pinned version and its content hash, the markets, site, line and
-- batch size, the control recipe and its hash), and recipe-core 0501 issues a planned GMP batch only under the issuer's
-- own valid ISSUED signature of it. The server shows and binds that content as the kernel computes it (the
-- GMP_BATCH_ISSUE signable action, features/execution/gmp-issue.ts), so this installation must:
--   * sign batch_issue records with ISSUED through the kernel's content (tab.kernel_signing_meanings, 0410: until now
--     only the stub aggregate; EBMR-TAB-019 otherwise), and
--   * read batch_issue records as RECORD-class records (tab.aggregate_read_class, 0410): a role holding RECORD.READ (the
--     batch issuer does, kernel 0120) previews the content it signs and reads its signatures; the row-level security of
--     esig.signature and esig.challenge for the application roles follows the same class.
-- Both are 0410's functions (their latest definitions) with only batch_issue added. CREATE OR REPLACE keeps the owner,
-- the grants and the row-level policies that call them. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

create or replace function tab.aggregate_read_class(p_aggregate_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'batch_issue', 'mbr_version', 'mbr_market_authorisation',
                                        'market_rule_correction', 'market_site_loosening', 'market_policy_version', 'record_type_version',
                                        'esig_stub', 'sample_record')
              then 'RECORD' else 'GOVERNANCE' end
$$;

create or replace function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_aggregate_type
           when 'esig_stub' then array['PERFORMED', 'VERIFIED', 'WITNESSED', 'LOGBOOK_PERFORMED', 'LOGBOOK_DOUBLE_CHECKED', 'PREPARED', 'CHECKED', 'APPROVED']
           when 'batch_issue' then array['ISSUED']
           else '{}'::text[]
         end
$$;

reset role;
