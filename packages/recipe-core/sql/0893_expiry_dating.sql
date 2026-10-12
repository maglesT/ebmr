-- Expiry dating computed by the database, never typed (Phase 4 slice 6a; plan default D-6-3, D-6a-3; control PR-43; IN-19
-- (b); ADR 0012).
--
--   recipe.expiry_month_end(manufacture date, shelf life months)  D-6-3: the manufacture date plus the shelf life, rounded
--       down to a month end as the label shows month and year: the last day of the month before the month in which the
--       manufacture date plus the shelf life falls (24 months from 15 March 2026 is 29 February 2028; from 31 January 2026
--       it is 31 December 2027: the label month never runs past the shelf life). Default D-6a-3.
--   recipe.batch_shelf_life(batch)  the product master version in effect when the batch was made (its issue instant), so
--       a new shelf life applies only to batches made after it took effect (PR-43); a batch issued before any version
--       took effect (installations from before 0802) takes the first version that did. With the stability basis of that
--       shelf life (site.shelf_life_basis_of) and whether it is tentative.
--   recipe.source_batch_expiry: CREATE OR REPLACE from its latest definition (0624). Same result shape (the first day of
--       the expiry month, as tablets 1022 and 1150 read it), the shelf life now from recipe.batch_shelf_life.
--   recipe.batch_expiry(batch)  the expiry of a GMP batch for its labels and records: for a packaging order the
--       processing batch it packs; {manufactureDate, shelfLifeMonths, expiryDate (month end, or the earlier recovered-input
--       cap, IN-19 (b)), expiryMonth, capped, masterVersionId, stabilityReference, tentative}; NULL when no shelf life is
--       known. The tablets print data and finished-lot posting read recipe.source_batch_expiry today; moving them to the
--       month end of this function needs a tablets migration (residual for the lead, D-6a-3).

set local role ebmr_owner;

create function recipe.expiry_month_end(p_manufactured date, p_months integer) returns date
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_manufactured is null or p_months is null or p_months < 1 then null
              else (date_trunc('month', p_manufactured) + make_interval(months => p_months))::date - 1 end
$$;

-- {versionId, shelfLifeMonths, stabilityReference, tentative} of the batch's product at its issue (header), or NULL.
create function recipe.batch_shelf_life(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b    recipe.batch_execution;
  v_p  jsonb := recipe.batch_product(p_batch);
  v    site.erp_product;
  s    site.shelf_life_stability;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  if b.id is null or v_p is null then
    return null;
  end if;
  v := site.erp_product_effective_at(v_p ->> 'code', v_p ->> 'strength', b.issued_at);
  if v.id is null then
    select p.* into v from site.erp_master_effect x join site.erp_product p on p.id = x.version_id
     where x.master_kind = 'PRODUCT' and x.master_key = site.erp_product_key(v_p ->> 'code', v_p ->> 'strength')
     order by x.effective_at, x.id limit 1;
  end if;
  if v.id is null then
    return null;
  end if;
  s := site.shelf_life_basis_of(v.product_code, v.strength, v.shelf_life_months);
  return jsonb_build_object('versionId', v.id, 'shelfLifeMonths', v.shelf_life_months, 'stabilityReference', s.stability_reference,
                            'tentative', coalesce(s.tentative, false));
end
$$;

-- As 0624, with the shelf life in effect at the batch's issue (header).
create or replace function recipe.source_batch_expiry(p_batch uuid) returns date
language sql stable security definer set search_path = pg_catalog, recipe, site, kernel, pg_temp as $$
  select (date_trunc('month', (b.issued_at at time zone kernel.site_zone())::date)
          + make_interval(months => (sl ->> 'shelfLifeMonths')::integer - 1))::date
    from recipe.batch_execution b,
         lateral (select recipe.batch_shelf_life(b.id) as sl) x
   where b.id = p_batch and jsonb_typeof(x.sl -> 'shelfLifeMonths') = 'number' and (x.sl ->> 'shelfLifeMonths')::integer >= 1
$$;

-- PR-43, D-6-3 (header).
create function recipe.batch_expiry(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, kernel, pg_temp as $$
declare
  v_proc uuid := coalesce(recipe.packaging_parent_of(p_batch), p_batch);
  b      recipe.batch_execution;
  v_sl   jsonb;
  v_mfg  date;
  v_exp  date;
  v_cap  date;
begin
  select * into b from recipe.batch_execution where id = v_proc;
  v_sl := recipe.batch_shelf_life(v_proc);
  if b.id is null or v_sl is null then
    return null;
  end if;
  v_mfg := (b.issued_at at time zone kernel.site_zone())::date;
  v_exp := recipe.expiry_month_end(v_mfg, (v_sl ->> 'shelfLifeMonths')::integer);
  v_cap := (recipe.recovered_expiry_cap(v_proc) at time zone 'UTC')::date;
  return jsonb_build_object(
    'batchId', p_batch, 'processingBatchId', v_proc, 'manufactureDate', to_char(v_mfg, 'YYYY-MM-DD'),
    'shelfLifeMonths', (v_sl ->> 'shelfLifeMonths')::integer,
    'expiryDate', to_char(least(v_exp, coalesce(v_cap, v_exp)), 'YYYY-MM-DD'),
    'expiryMonth', to_char(least(v_exp, coalesce(v_cap, v_exp)), 'YYYY-MM'),
    'capped', v_cap is not null and v_cap < v_exp,
    'masterVersionId', v_sl ->> 'versionId', 'stabilityReference', v_sl ->> 'stabilityReference', 'tentative', (v_sl ->> 'tentative')::boolean);
end
$$;

revoke all on function recipe.expiry_month_end(date, integer), recipe.batch_shelf_life(uuid), recipe.batch_expiry(uuid) from public;
grant execute on function recipe.expiry_month_end(date, integer), recipe.batch_shelf_life(uuid), recipe.batch_expiry(uuid) to ebmr_app;

reset role;
