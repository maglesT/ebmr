-- Slice 6 review fixes, tablets part (Phase 3 slice 6a; controls DI-13, DI-17, DI-37; ADR 0012).
--
--   * DI-13: a formula version's content (its composition, recipe-core 0640) and the content of an MBR version that pins a
--     formula version (its BOM) are read only by a session whose role holds FORMULA.READ in the product's scope:
--     tab.record_read_problem (latest: 0530) adds that rule to the RECORD class, so the e-signature content preview, the
--     signatures and the audit reads that ask it refuse them (EBMR-TAB-020) like any record the session may not read.
--   * DI-13 (product scope): tab.formula_reader_may decides FORMULA.READ by the session's role and its grant's scope for
--     the product (as iam.evaluate_authority scopes a grant), without writing; tab.formula_read, tab.formula_choice and
--     tab.mbr_composition_check (1041) use it, each formula judged by its own product.
--   * DI-37: the retest decision is signed on aggregate lot_retest (site-services 0762): RECORD class, meaning
--     LOT_RETEST_APPROVED; a material lot is no longer signed with it.
--   * DI-17: the planning read (recipe-core 0641) for the session whose role holds BATCH.ISSUE (tab.planning_orders).
-- Nothing else changes; CREATE OR REPLACE keeps owners, grants and the policies that call these functions.

set local role ebmr_owner;

-- DI-13: FORMULA.READ of the session's role, in the scope of the session's site and product p_product (NULL: no product).
create function tab.formula_reader_may(r tab.reader, p_product text) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select tab.role_may(r.role_code, array['FORMULA.READ'])
     and exists (select 1 from iam.role_grant g
                  where g.account_id = r.account_id and g.role_code = r.role_code
                    and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
                    and iam.scope_covers(g.scope_site, g.scope_area, g.scope_product,
                                         iam.check_scope(jsonb_build_object('site', (select s.site_code from iam.session s where s.id = r.session_id), 'product', p_product))))
$$;

-- The product whose composition a record carries (a formula version, or an MBR version pinning one), else NULL.
create function tab.composition_product(p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, formulary, pg_temp as $$
begin
  if coalesce(p_aggregate_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  if p_aggregate_type = 'formula_version' then
    return coalesce((select f.product_code from formulary.formula_version v join formulary.formula f on f.id = v.formula_id where v.id = p_aggregate_id::uuid), '?');
  end if;
  if p_aggregate_type = 'mbr_version' and recipe.mbr_formula_of(p_aggregate_id::uuid) is not null then
    return coalesce(recipe.version_scope(p_aggregate_id::uuid) ->> 'product', '?');
  end if;
  return null;
end
$$;

create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_product text;
begin
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

create or replace function tab.formula_read(p_token_hash text, p_formula uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, formulary, pg_temp as $$
declare
  r     tab.reader := tab.reader_of(p_token_hash);
  f     formulary.formula;
  v_out jsonb := '[]'::jsonb;
begin
  if p_formula is not null and not exists (select 1 from formulary.formula x where x.id = p_formula) then
    return recipe.formula_listing(p_formula, false);
  end if;
  for f in select * from formulary.formula x where p_formula is null or x.id = p_formula order by x.product_code, x.strength, x.batch_size_units loop
    v_out := v_out || recipe.formula_listing(f.id, tab.formula_reader_may(r, f.product_code));
  end loop;
  return v_out;
end
$$;

drop function tab.formula_reader_refusal(tab.reader);
create function tab.formula_reader_refusal(r tab.reader, p_product text) returns void
language plpgsql stable set search_path = pg_catalog, tab, pg_temp as $$
begin
  if not tab.formula_reader_may(r, p_product) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-040 %s acting as %s lacks permission FORMULA.READ for product %s: a formula''s composition is confidential (DI-13, D-S6-4)',
                       r.account_id, r.role_code, coalesce(p_product, '(any)'));
  end if;
end
$$;

create or replace function tab.formula_choice(p_token_hash text, p_product text, p_strength text, p_units numeric) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
begin
  perform tab.formula_reader_refusal(tab.reader_of(p_token_hash), p_product);
  return recipe.formula_choice_of(p_product, p_strength, p_units);
end
$$;

create or replace function tab.mbr_composition_check(p_token_hash text, p_mbr uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
begin
  if recipe.mbr_formula_of(p_mbr) is not null then
    perform tab.formula_reader_refusal(tab.reader_of(p_token_hash), recipe.version_scope(p_mbr) ->> 'product');
  end if;
end
$$;

-- DI-17: the planning read for a session whose role holds BATCH.ISSUE.
create function tab.planning_orders(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, iam, pg_temp as $$
declare
  r tab.reader := tab.reader_of(p_token_hash);
begin
  if not tab.role_may(r.role_code, array['BATCH.ISSUE']) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-040 %s acting as %s lacks permission BATCH.ISSUE: the planning of batches is the issuer''s (DI-17)', r.account_id, r.role_code);
  end if;
  return recipe.planning_orders((select s.site_code from iam.session s where s.id = r.session_id));
end
$$;

-- DI-37: the retest decision's own aggregate; a lot is no longer signed LOT_RETEST_APPROVED.
create or replace function tab.aggregate_read_class(p_aggregate_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'batch_issue', 'mbr_version', 'mbr_market_authorisation',
                                        'market_rule_correction', 'market_site_loosening', 'market_policy_version', 'record_type_version',
                                        'esig_stub', 'sample_record',
                                        'batch_act', 'deviation', 'lot_test_result', 'qc_extra_testing', 'material_lot', 'output_container',
                                        'reprocessing_authorisation', 'reprocessing_request', 'formula_version',
                                        'plant_cleaning', 'plant_clearance', 'plant_equipment_repair',
                                        'lot_retest')
              then 'RECORD' else 'GOVERNANCE' end
$$;

create or replace function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_aggregate_type
           when 'esig_stub' then array['PERFORMED', 'VERIFIED', 'WITNESSED', 'LOGBOOK_PERFORMED', 'LOGBOOK_DOUBLE_CHECKED', 'PREPARED', 'CHECKED', 'APPROVED']
           when 'batch_issue' then array['ISSUED']
           when 'batch_act' then array['VOID_AUTHORISED']
           when 'deviation' then array['DEVIATION_CONCLUDED', 'DEVIATION_CLOSED']
           when 'lot_test_result' then array['QC_RESULT_APPROVED']
           when 'qc_extra_testing' then array['QC_EXTRA_TESTING_DECIDED']
           when 'material_lot' then array['MATERIAL_LOT_RELEASED', 'MATERIAL_LOT_REJECTED', 'MATERIAL_LOT_STATUS_DECIDED']
           when 'lot_retest' then array['LOT_RETEST_APPROVED']
           when 'output_container' then array['RESIDUE_RESERVED']
           when 'reprocessing_authorisation' then array['REPROCESSING_AUTHORISED']
           when 'reprocessing_request' then array['REPROCESSING_AUTHORISED']
           when 'formula_version' then array['FORMULA_APPROVED']
           when 'plant_cleaning' then array['LOGBOOK_DOUBLE_CHECKED']
           when 'plant_clearance' then array['VERIFIED']
           when 'plant_equipment_repair' then array['LOGBOOK_DOUBLE_CHECKED']
           else '{}'::text[]
         end
$$;

revoke all on function tab.formula_reader_may(tab.reader, text), tab.composition_product(text, text), tab.formula_reader_refusal(tab.reader, text),
                       tab.planning_orders(text) from public;
grant execute on function tab.planning_orders(text) to ebmr_app;

reset role;
