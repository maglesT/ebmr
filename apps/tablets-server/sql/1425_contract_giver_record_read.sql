-- Phase 7 slice 7b-1 (review residual 6jc-R3; IN-30): the contract giver's reviewer reads nothing through the record
-- reads; its loan licence's batches are read through its own scoped, logged reads only.
--
-- Handbook: modules/tablets-server.md
--
-- Why. The role CONTRACT_GIVER_REVIEWER (kernel 1204) also holds RECORD.READ (kernel 0120). Its scope to the batches of
-- one loan licence held in its own reads (recipe.read_contract_giver_batch, recipe-core 1060: a live access, the account
-- read-only, every read logged) and in the server's route allow-list (bind.ts), but tab.record_read_problem let the role
-- read any RECORD-class record (signing content, signatures, audit chains of any batch, any licence) by RECORD.READ: the
-- database alone did not hold the scope.
--
-- tab.record_read_problem: CREATE OR REPLACE from its latest definition (tablets 1414), same signature, owner, SECURITY
-- DEFINER, search_path and privileges. First, a reader acting as CONTRACT_GIVER_REVIEWER, or whose account holds that role
-- now in any grant (bind.ts refuses such a session too), is refused for every record: what it may read of its loan
-- licence is read through its own reads, which check the live access and log each read; nothing of its licence is read
-- here, so nothing it may read is lost. Then every rule of 1414 in the same order and with the same messages (the
-- controlled records with CONTROLLED.READ in scope, the support grants, the RECORD class with FORMULA.READ, the
-- GOVERNANCE class). A later migration that re-creates it starts from this definition.

set local role ebmr_owner;

create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_product text;
  v_scope   jsonb;
begin
  -- Phase 7 slice 7b-1 (tablets 1425, 6jc-R3, IN-30): the contract giver's reviewer reads its loan licence's batches
  -- through its own logged reads (recipe-core 1060) only; no record is read here in that role or by such an account.
  if p_reader.role_code = 'CONTRACT_GIVER_REVIEWER'
     or exists (select 1 from iam.role_grant g
                 where g.account_id = p_reader.account_id and g.role_code = 'CONTRACT_GIVER_REVIEWER'
                   and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())) then
    return format('the contract giver''s reviewer reads only the batches of its loan licence, through its own logged reads (IN-30); %s %s is not read here',
                  p_aggregate_type, coalesce(p_aggregate_id, '(none)'));
  end if;
  -- Phase 6 slice 6e (tablets 1290, IN-53): a controlled-substance record is read by the roles that record or sign that
  -- kind (and, as every GOVERNANCE record, by the roles that review audit trails, data integrity or access, or audit).
  if p_aggregate_type in ('controlled_product', 'controlled_custody', 'controlled_checkpoint') then
    if not tab.role_may(p_reader.role_code, case p_aggregate_type
                                              when 'controlled_product' then array['CONTROLLED.RECORD', 'CONTROLLED.APPROVE']
                                              when 'controlled_custody' then array['CONTROLLED.CUSTODY']
                                              else array['CONTROLLED.BALANCE'] end)
       and not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
      return format('%s records are read only by the roles that record or sign them (IN-53); the role %s does not', p_aggregate_type, p_reader.role_code);
    end if;
    -- Phase 7 slice 7a (tablets 1414, 6jc-R2, IN-53): and only with CONTROLLED.READ in the record's scope.
    v_scope := tab.controlled_record_scope(p_aggregate_type, p_aggregate_id);
    return regexp_replace(tab.controlled_reader_problem(p_reader, coalesce(v_scope ->> 'site', tab.reader_site(p_reader)), v_scope ->> 'product', v_scope is null),
                          '^EBMR-[A-Z]+-[0-9]{3} ', '');
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
