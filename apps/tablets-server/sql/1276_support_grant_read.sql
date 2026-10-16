-- Phase 6 slice 6f: who may read a vendor support grant as content to be signed (DI-08; kernel 1202, tablets 1275).
--
-- Handbook: modules/tablets-server.md
--
-- tab.record_read_problem: CREATE OR REPLACE from its latest definition (1042), same signature, owner, SECURITY DEFINER,
-- search_path and privileges. A support grant (a GOVERNANCE record) is read by the roles that request or approve one
-- (SUPPORT.GRANT_REQUEST, SUPPORT.APPROVE_QA, SUPPORT.APPROVE_IT), so QA's approver and the system owner can see what
-- they sign; every other type keeps its rule unchanged.

set local role ebmr_owner;

create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_product text;
begin
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
