-- The planning screen's read of open ERP production orders (Phase 3 slice 6a; controls INV-01, PR-01, IN-24 via the
-- issue's ERP order check of 0602). Read-only: the plan (recipe.prepare_gmp_issue) and the issue check everything again.
--
--   recipe.planning_orders(site)   the site's open orders (the latest receipt of each order number, not yet planned into
--                                  a batch) with, for each, the MBR family of its product and strength that has an approved
--                                  batch size of the order's quantity, and the highest MBR version authorised now at the
--                                  site for that size (any line, any market): {familyId, familyCode, versionId,
--                                  versionNumber, batchSizeId, markets}; or why none matches (no family, no batch size of
--                                  that quantity, no version authorised now, or the issue's ERP order check refuses it,
--                                  e.g. a BOM that differs from the MBR's); and the batches planned for the order.

set local role ebmr_owner;

create function recipe.planning_orders(p_site text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  o        site.erp_production_order;
  f        recipe.mbr_family;
  v_size   text;
  v_ver    record;
  v_match  jsonb;
  v_why    text;
  v_out    jsonb := '[]'::jsonb;
  v_any_f  boolean;
begin
  for o in
    select x.* from site.erp_production_order x
     where x.site_code = p_site
       and x.id = (select y.id from site.erp_production_order y where y.order_no = x.order_no order by y.received_at desc, y.id desc limit 1)
     order by x.received_at, x.order_no
  loop
    v_match := null;
    v_why := null;
    v_any_f := false;
    for f in select * from recipe.mbr_family m where m.product_code = o.product_code and m.strength = o.strength order by m.code loop
      v_any_f := true;
      select s ->> 'id' into v_size from jsonb_array_elements(f.batch_sizes) s
       where s -> 'quantity' ->> 'unit' = o.batch_size_unit and (s -> 'quantity' ->> 'value') ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$'
         and (s -> 'quantity' ->> 'value')::numeric = o.batch_size
       limit 1;
      if v_size is null then
        v_why := coalesce(v_why, format('MBR family %s has no approved batch size of %s %s (PR-01)', f.code, trim_scale(o.batch_size), o.batch_size_unit));
        continue;
      end if;
      select c.version_id, c.version_number, array_agg(distinct c.market order by c.market) as markets into v_ver
        from recipe.authorisation_cell c join recipe.mbr_version v on v.id = c.version_id
       where c.family_id = f.id and c.site = p_site and c.batch_size = v_size
         and c.effective_from <= clock_timestamp() and clock_timestamp() < coalesce(c.valid_until, 'infinity'::timestamptz)
         and v.effective_from is not null and v.effective_from <= clock_timestamp()
         and recipe.version_state_at(c.version_id, clock_timestamp()) = 'APPROVED'
       group by c.version_id, c.version_number
       order by c.version_number desc limit 1;
      if v_ver.version_id is null then
        v_why := coalesce(v_why, format('No version of MBR family %s is authorised now at site %s for batch size %s (INV-01)', f.code, p_site, v_size));
        continue;
      end if;
      v_why := recipe.erp_order_problem(o.order_no, site.erp_order_of(o.order_no), f, p_site, v_size, (recipe.current_content(v_ver.version_id)).content);
      if v_why is not null then
        continue;
      end if;
      v_match := jsonb_build_object('familyId', f.id, 'familyCode', f.code, 'versionId', v_ver.version_id, 'versionNumber', v_ver.version_number::text,
                                    'batchSizeId', v_size, 'markets', to_jsonb(v_ver.markets));
      exit;
    end loop;
    if not v_any_f then
      v_why := format('No MBR family is recorded for %s %s (INV-01)', o.product_code, o.strength);
    end if;
    v_out := v_out || jsonb_build_object(
      'orderNo', o.order_no, 'productCode', o.product_code, 'strength', o.strength,
      'productName', (select p.product_name from site.erp_product p where p.product_code = o.product_code and p.strength = o.strength order by p.received_at desc, p.id desc limit 1),
      'batchSize', trim_scale(o.batch_size)::text, 'batchSizeUnit', o.batch_size_unit, 'bom', o.bom,
      'match', v_match, 'noMatch', case when v_match is null then coalesce(v_why, 'No MBR matches this order') end,
      'batches', coalesce((select jsonb_agg(jsonb_build_object('batchId', b.id, 'batchNumber', b.batch_number, 'status', b.status) order by b.recorded_at)
                             from recipe.batch_erp_order e join recipe.stub_batch b on b.id = e.batch_id where e.order_no = o.order_no), '[]'::jsonb));
  end loop;
  return v_out;
end
$$;

revoke all on function recipe.planning_orders(text) from public;
grant execute on function recipe.planning_orders(text) to ebmr_app;

reset role;
