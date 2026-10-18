-- Phase 7 slice 7a, 6jc-R2 (draft control IN-53, status U): a controlled-substance record read as content to be signed,
-- or through its signatures and their audit chains, also needs CONTROLLED.READ in the record's scope (tablets 1413).
--
-- Handbook: modules/tablets-server.md
--
-- tab.record_read_problem: CREATE OR REPLACE from its latest definition (1290), same signature, owner, SECURITY DEFINER,
-- search_path and privileges. Every rule of 1290 stays, in the same order and with the same messages: a controlled
-- record is read by the roles that record or sign that kind or by the governance readers; the support grants (1276), the
-- RECORD class with the formulation library's FORMULA.READ (1042) and the GOVERNANCE class are unchanged. Added for the
-- three controlled types only: after that rule, the reader must also pass tab.controlled_reader_problem (1413) in the
-- record's scope (tab.controlled_record_scope below; an unknown record is judged in the session's site, any product), so
-- a governance reader without CONTROLLED.READ (a CSV/DI lead, an auditor), or a holder limited to another product or
-- site, no longer reads one. The answer is the problem without its code (the callers add theirs, EBMR-TAB-020).
--
-- tab.controlled_preview: CREATE OR REPLACE from its latest definition (1250), same signature, owner, SECURITY DEFINER,
-- search_path and privileges; the pair check (EBMR-TAB-019) and the meaning's permission check (EBMR-TAB-020) stay as
-- they were, then the reader must pass the same CONTROLLED.READ rule (EBMR-CSM-060 or 061, 403).
-- A later migration that re-creates either function starts from this definition.

set local role ebmr_owner;

-- The {site, product} of a controlled record: a flag {product}, a custody record {lot's site, batch's product when it
-- names a batch}, a checkpoint {batch's site, batch's product}; NULL when the id is malformed or names no record.
create function tab.controlled_record_scope(p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, site, pg_temp as $$
declare
  v_id uuid;
begin
  if coalesce(p_aggregate_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_id := p_aggregate_id::uuid;
  if p_aggregate_type = 'controlled_product' then
    return (select jsonb_build_object('product', r.product_code) from plant.controlled_product r where r.id = v_id);
  end if;
  if p_aggregate_type = 'controlled_custody' then
    return (select jsonb_strip_nulls(jsonb_build_object('site', l.site_code,
                     'product', case when c.batch_id is null then null else recipe.batch_product(c.batch_id) ->> 'code' end))
              from recipe.controlled_custody c join site.material_lot l on l.id = c.lot_id where c.id = v_id);
  end if;
  if p_aggregate_type = 'controlled_checkpoint' then
    return (select tab.controlled_batch_scope(k.batch_id) from recipe.controlled_checkpoint k where k.id = v_id);
  end if;
  return null;
end
$$;

create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_product text;
  v_scope   jsonb;
begin
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

create or replace function tab.controlled_preview(p_token_hash text, p_type text, p_id text, p_meaning text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
declare
  v_reader tab.reader := tab.reader_of(p_token_hash);
  v_type   esig.meaning_type;
  v_scope  jsonb;
begin
  if not tab.controlled_pair_ok(p_type, p_meaning) then
    raise exception using errcode = 'P0001', message = format('A %s record is not signed %s (IN-53). [EBMR-TAB-019]', coalesce(p_type, '(none)'), coalesce(p_meaning, '(none)'));
  end if;
  v_type := esig.current_meaning(p_meaning);
  if not tab.role_may(v_reader.role_code, v_type.permissions) then
    raise exception using errcode = 'P0001',
      message = format('This session may not read %s %s: the role %s may not sign %s. [EBMR-TAB-020]', p_type, p_id, v_reader.role_code, p_meaning);
  end if;
  -- Phase 7 slice 7a (tablets 1414, 6jc-R2, IN-53): and only with CONTROLLED.READ in the record's scope.
  v_scope := tab.controlled_record_scope(p_type, p_id);
  perform tab.controlled_reader_refusal(v_reader, coalesce(v_scope ->> 'site', tab.reader_site(v_reader)), v_scope ->> 'product', v_scope is null);
  return esig.content_for_signing(p_type, p_id);
end
$$;

revoke all on function tab.controlled_record_scope(text, text) from public;

reset role;
