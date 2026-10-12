-- Recipe core, Phase 4 slice 2c: the planning reads of packaging orders and their bulk issue (outline 5.2.2, 5.2.8,
-- 5.2.9; Phase 3 exit residual "no screen for the bulk issue"; controls INV-27, IN-18, L-30). Read-only: the plan
-- (recipe.prepare_gmp_issue, 0761) and the bulk issue (recipe.issue_packaging_bulk, 0701) check everything again.
--
--   * recipe.packaging_parent_candidates(product, site): the issued processing batches of the product at the site a
--     packaging order may pack (recipe.packaging_parent_problem is NULL), newest first, each with why it is not released
--     for packing yet (recipe.release_for_packing_problem) and its usable containers' count.
--   * recipe.planning_orders(site), replaced from 0641: a match names its record kind and pack type, and a packaging
--     match its parent candidates. Nothing else changes (owner only; tablets 1042 reads it for the session).
--   * recipe.packaging_orders(site): the site's packaging orders (planned or issued) with their family, pack type,
--     processing batch, its release for packing, and the bulk issued to each.
--   * recipe.packaging_order_bulk(order): one packaging order for the bulk-issue screen: the order, its processing batch
--     and why it is not released for packing, the bulk issued to it, and every output container of the processing batch
--     with its net quantity and why it cannot be issued now (plant.container_usable_problem; no net quantity), so the
--     screen shows only the database's words.

set local role ebmr_owner;

create function recipe.packaging_parent_candidates(p_product text, p_site text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'batchId', b.id, 'batchNumber', b.batch_number,
           'status', coalesce((select s.status from recipe.execution_state s where s.batch_id = b.id), sb.status),
           'releaseForPackingProblem', recipe.release_for_packing_problem(b.id),
           'usableContainers', (select count(*) from plant.output_container c where c.batch_id = b.id and plant.container_usable_problem(c.id) is null)::int)
         order by sb.recorded_at desc, b.batch_number), '[]'::jsonb)
    from recipe.batch_execution b
    join recipe.stub_batch sb on sb.id = b.id
    join recipe.mbr_family f on f.id = sb.family_id
   where b.purpose = 'GMP_BATCH' and f.record_kind = 'PROCESSING' and f.product_code = p_product and sb.site = p_site
     and recipe.packaging_parent_problem(p_product, p_site, b.id) is null
$$;

-- As 0641, with the record kind, pack type and parent candidates of a match (header).
create or replace function recipe.planning_orders(p_site text) returns jsonb
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
                                    'batchSizeId', v_size, 'markets', to_jsonb(v_ver.markets), 'recordKind', f.record_kind,
                                    'packType', recipe.family_pack_type(f.id),
                                    -- A packaging order packs an issued processing batch of the product at the site (D-S4-2):
                                    -- the candidates, each with why it is not released for packing yet (0701), or [].
                                    'parents', case when f.record_kind = 'PACKAGING' then recipe.packaging_parent_candidates(f.product_code, p_site) else '[]'::jsonb end);
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

create function recipe.packaging_orders(p_site text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'batchId', sb.id, 'batchNumber', sb.batch_number,
           'status', coalesce((select s.status from recipe.execution_state s where s.batch_id = sb.id), sb.status),
           'familyCode', f.code, 'packType', recipe.family_pack_type(f.id), 'productCode', f.product_code, 'strength', f.strength,
           'line', sb.line, 'markets', to_jsonb(sb.markets),
           'parentBatchId', recipe.packaging_parent_of(sb.id),
           'parentBatchNumber', (select x.batch_number from recipe.batch_execution x where x.id = recipe.packaging_parent_of(sb.id)),
           'releaseForPackingProblem', case when recipe.packaging_parent_of(sb.id) is not null then recipe.release_for_packing_problem(recipe.packaging_parent_of(sb.id)) end,
           'bulkContainers', (select count(*) from recipe.packaging_bulk_issue i where i.order_batch_id = sb.id)::int)
         order by sb.recorded_at desc, sb.batch_number), '[]'::jsonb)
    from recipe.stub_batch sb
    join recipe.mbr_family f on f.id = sb.family_id
   where f.record_kind = 'PACKAGING' and sb.site = p_site
     and exists (select 1 from recipe.batch_allocation_link l where l.batch_id = sb.id)
$$;

create function recipe.packaging_order_bulk(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  sb       recipe.stub_batch;
  f        recipe.mbr_family;
  v_parent uuid;
  v_status text;
begin
  select * into sb from recipe.stub_batch where id = p_order;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if sb.id is null or f.record_kind is distinct from 'PACKAGING' then
    return null;
  end if;
  v_parent := recipe.packaging_parent_of(p_order);
  v_status := coalesce((select s.status from recipe.execution_state s where s.batch_id = p_order), sb.status);
  return jsonb_build_object(
    'batchId', sb.id, 'batchNumber', sb.batch_number, 'status', v_status,
    'familyCode', f.code, 'packType', recipe.family_pack_type(f.id), 'productCode', f.product_code, 'strength', f.strength, 'line', sb.line,
    -- Bulk is issued only to an order that is issued or running (0701, EBMR-PKG-001).
    'orderProblem', case when not exists (select 1 from recipe.batch_execution x where x.id = p_order and x.purpose = 'GMP_BATCH') or v_status not in ('ISSUED', 'IN_PROGRESS')
                         then format('packaging order %s is %s: bulk is issued only to a packaging order that is issued or running', sb.batch_number, v_status) end,
    'parent', case when v_parent is not null then jsonb_build_object(
                'batchId', v_parent,
                'batchNumber', (select x.batch_number from recipe.batch_execution x where x.id = v_parent),
                'releaseForPackingProblem', coalesce(recipe.packaging_parent_problem(f.product_code, sb.site, v_parent), recipe.release_for_packing_problem(v_parent))) end,
    'issued', coalesce((select jsonb_agg(jsonb_build_object(
                 'label', c.label_code, 'containerId', c.id, 'quantity', trim_scale(i.quantity)::text, 'unit', i.unit,
                 'personId', i.person_id, 'issuedUs', (extract(epoch from i.recorded_at) * 1000000)::numeric(20, 0)::text)
               order by i.recorded_at, c.label_code)
          from recipe.packaging_bulk_issue i join plant.output_container c on c.id = i.container_id where i.order_batch_id = p_order), '[]'::jsonb),
    'containers', coalesce((select jsonb_agg(jsonb_build_object(
                 'label', c.label_code, 'containerId', c.id, 'stage', c.stage, 'state', plant.container_state(c.id),
                 'netQuantity', (select trim_scale(x.net_quantity)::text from plant.container_close x where x.container_id = c.id), 'unit', c.quantity_unit,
                 'issueProblem', coalesce(
                    (select format('issued to packaging order %s', o.batch_number) from recipe.packaging_bulk_issue i join recipe.batch_execution o on o.id = i.order_batch_id where i.container_id = c.id),
                    plant.container_usable_problem(c.id),
                    case when not exists (select 1 from plant.container_close x where x.container_id = c.id) then format('container %s has no net quantity', c.label_code) end))
               order by c.opened_at, c.label_code)
          from plant.output_container c where c.batch_id = v_parent), '[]'::jsonb));
end
$$;

revoke all on function recipe.packaging_parent_candidates(text, text), recipe.packaging_orders(text), recipe.packaging_order_bulk(uuid) from public;
grant execute on function recipe.packaging_orders(text), recipe.packaging_order_bulk(uuid) to ebmr_app;

reset role;
