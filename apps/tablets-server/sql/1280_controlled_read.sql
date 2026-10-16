-- Phase 6 slice 6e: who may read a controlled-substance record as content to be signed (draft IN-53; tablets 1250).
--
-- Handbook: modules/tablets-server.md
--
-- tab.record_read_problem: CREATE OR REPLACE from its latest definition (1276), same signature, owner, SECURITY DEFINER,
-- search_path and privileges. A controlled_product record is read by the roles holding CONTROLLED.RECORD or
-- CONTROLLED.APPROVE, a controlled_custody record by those holding CONTROLLED.CUSTODY (the custodians on the floor and in
-- the stores), a controlled_checkpoint by those holding CONTROLLED.BALANCE, and each by the governance readers; every
-- other type keeps its rule unchanged.
--
-- Numbered 1280, after slice 6e's own range (1250 to 1258), because 6f's 1276 re-creates this function after that range
-- and would undo a change made inside it (default D-P6e-10; the plan's migration table gains "6e: tablets 1280 to 1289").
-- A later migration that re-creates this function starts from this definition.

set local role ebmr_owner;

create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_product text;
begin
  -- Phase 6 slice 6e (tablets 1280, IN-53): a controlled-substance record is read by the roles that record or sign that
  -- kind (and, as every GOVERNANCE record, by the roles that review audit trails, data integrity or access, or audit).
  if p_aggregate_type in ('controlled_product', 'controlled_custody', 'controlled_checkpoint') then
    if not tab.role_may(p_reader.role_code, case p_aggregate_type
                                              when 'controlled_product' then array['CONTROLLED.RECORD', 'CONTROLLED.APPROVE']
                                              when 'controlled_custody' then array['CONTROLLED.CUSTODY']
                                              else array['CONTROLLED.BALANCE'] end)
       and not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
      return format('%s records are read only by the roles that record or sign them (IN-53); the role %s does not', p_aggregate_type, p_reader.role_code);
    end if;
    return null;
  end if;
  -- Phase 6 slice 6f (tablets 1276, DI-08): a vendor support grant is read by those who request or approve one.
  if p_aggregate_type = 'support_grant' then
    if not tab.role_may(p_reader.role_code, array['SUPPORT.GRANT_REQUEST', 'SUPPORT.APPROVE_QA', 'SUPPORT.APPROVE_IT']) then
      return format('support grants are read only by the roles that request or approve them; the role %s does not', p_reader.role_code);
    end if;
    return null;
  end if;
  if tab.aggregate_read_class(p_aggregate_type) = 'RECORD' then
    if not tab.role_may(p_reader.role_code, array['RECORD.READ']) then
      return format('the role %s does not hold RECORD.READ', p_reader.role_code);
    end if;
    -- DI-13 (slice 6 review): a composition from the formulation library is read only with FORMULA.READ.
    v_product := tab.composition_product(p_aggregate_type, p_aggregate_id);
    if v_product is not null and not tab.formula_reader_may(p_reader, v_product) then
      return format('%s %s carries a composition of the formulation library, read only with FORMULA.READ; the role %s does not hold it for product %s (DI-13)',
                    p_aggregate_type, p_aggregate_id, p_reader.role_code, v_product);
    end if;
    return null;
  end if;
  if not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
    return format('%s records are read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these',
                  p_aggregate_type, array_to_string(tab.governance_read_permissions(), ', '), p_reader.role_code);
  end if;
  return null;
end
$$;

reset role;
