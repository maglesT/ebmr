-- A confirmed laboratory error counts only once the OOS record is concluded (Phase 4 slice 2a, after 2b; the full
-- deviation states of 0820).
--
-- site.oos_confirmed_lab_error (0841) counted every state but OPEN, UNDER_INVESTIGATION and CANCELLED, so a state added
-- later between them and the conclusion (IMPACT_ASSESSED) would have counted. Re-created from 0841: the QA-signed
-- conclusion row (assignable cause, LABORATORY_ERROR) AND the state PENDING_CLOSURE or CLOSED, both. CREATE OR REPLACE
-- keeps the owner and the grants (none to ebmr_app).

set local role ebmr_owner;

-- As 0841_lims_from_specification.sql; the concluded states named (header).
create or replace function site.oos_confirmed_lab_error(p_dev uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.deviation_conclusion c
                  where c.deviation_id = p_dev and c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR'
                    and site.deviation_state(p_dev) in ('PENDING_CLOSURE', 'CLOSED'))
$$;

reset role;
