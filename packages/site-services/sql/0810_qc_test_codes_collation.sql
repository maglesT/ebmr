-- Site services: the canonical order of QC test codes no longer depends on the database's collation (Phase 3 exit
-- mutation backlog, medium; Phase 4 slice 1b; control PR-47 release part).
--
-- site.qc_test_codes (0733) sorted the tests with the database's default collation. The signed aggregate id of a QC
-- extra-testing decision is built from that order (site.qc_extra_testing_aggregate_id), and the server builds the same
-- id with a code-unit sort (src/features/quality/signables.ts). On a database whose default collation is not "C" the
-- two could differ for codes holding '.', '-' or '_', and the decision would become unsignable (it failed safe). The
-- order is now the "C" (code-point) order, as site-services 0762 already sorts lot retest results.
--
--   * site.qc_test_codes: CREATE OR REPLACE from 0733 (its only definition); the one change is `collate "C"` in the
--     ordering. It stays immutable, owned by ebmr_owner, with pg_temp last in its search_path (ADR 0016); its grant
--     to the application role is kept by CREATE OR REPLACE.
-- Rows recorded before this migration keep their ids: every installation so far runs under C.UTF-8, where the two
-- orders agree. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create or replace function site.qc_test_codes(p_tests text[]) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when exists (select 1 from unnest(coalesce(p_tests, '{}')) t where t is null or t !~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$') then null
              else coalesce((select array_agg(distinct t collate "C" order by t collate "C") from unnest(p_tests) t), '{}') end
$$;

reset role;
