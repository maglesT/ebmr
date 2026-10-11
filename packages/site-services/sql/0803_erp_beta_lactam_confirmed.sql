-- ERP stub: a product's beta-lactam flag is a controlled value too (Phase 3 exit review HIGH-1, follow-up; controls
-- PR-47, IN-38). The flag drives the isolation of the packing line (tablets 1002), which guards against
-- cross-contamination, so a version that changes it takes effect only once QA confirms it with ERP_MASTER_CONFIRMED,
-- like the reprocessing permission and the shelf life (0802). Until then the value in effect applies.
--
--   * site.erp_effect_if_unchanged (CREATE OR REPLACE from 0802): a product version takes effect on receipt only when
--     the version in effect has the same reprocessing permission, shelf life and beta-lactam flag. Nothing else changes.

set local role ebmr_owner;

create or replace function site.erp_effect_if_unchanged(p_kind text, p_version uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  p     site.erp_product;
  m     site.erp_material;
  cur_p site.erp_product;
  cur_m site.erp_material;
  v_key text;
  v_same boolean := false;
begin
  if p_kind = 'PRODUCT' then
    select * into p from site.erp_product where id = p_version;
    v_key := site.erp_product_key(p.product_code, p.strength);
    perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext('PRODUCT|' || v_key));
    cur_p := site.erp_product_effective(p.product_code, p.strength);
    v_same := cur_p.id is not null and cur_p.reprocessing_permitted = p.reprocessing_permitted and cur_p.shelf_life_months = p.shelf_life_months
              and cur_p.beta_lactam = p.beta_lactam;
  else
    select * into m from site.erp_material where id = p_version;
    v_key := m.material_code;
    perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext('MATERIAL|' || v_key));
    cur_m := site.erp_material_current(m.material_code);
    v_same := cur_m.id is not null and cur_m.material_kind = m.material_kind and cur_m.max_retest_months is not distinct from m.max_retest_months;
  end if;
  if v_same then
    insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id)
    values (p_kind, v_key, p_version, 'UNCHANGED', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  end if;
end
$$;

reset role;
