-- Recipe core: a GMP batch is planned against an ERP production order whose BOM matches the MBR (Phase 3 slice 5a
-- step 4; slice 5 plan D-S5-4, D-S2b-1; outline 5.2.2 "PLANNED -> ISSUED: the ERP order BOM matches the MBR BOM", 4.6).
--
--   * recipe.batch_erp_order: the order a planned batch was planned against (insert-only; an order plans one batch).
--   * recipe.erp_order_problem(order no, order, family, site, batch size id, content): NULL when the order exists and is
--     for the family's product and strength at the batch's site and for the chosen approved batch size (value and unit),
--     and its BOM holds exactly the MBR's BOM materials, each in the MBR's unit, with the MBR quantity scaled from the
--     reference batch size (the first approved size) to the chosen one, compared exactly (order quantity x reference size
--     = MBR quantity x chosen size); else why not.
--   * recipe.prepare_gmp_issue, replaced from its latest definition (0582): p_def.erpOrder names the order; after the
--     control recipe is pinned, the order is matched against its MBR content and recorded (EBMR-EXE-605). Every GMP
--     issue (processing, packaging and the reprocessing issue that calls this function) names one. Nothing else changes.
-- Messages: EBMR-EXE-605.

set local role ebmr_owner;

create table recipe.batch_erp_order (
  batch_id     uuid primary key references recipe.stub_batch (id),
  order_id     uuid not null,
  order_no     text not null unique,
  recorded_at  timestamptz not null default clock_timestamp()
);
revoke all on recipe.batch_erp_order from public;
select platform.enforce_db_time('recipe.batch_erp_order', array['recorded_at']);
select kernel.register_audited_table('recipe.batch_erp_order', 'batch', 'batch_id', true);

create function recipe.erp_order_problem(p_order_no text, p_order jsonb, f recipe.mbr_family, p_site text, p_size_id text, p_content jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ref   jsonb := p_content -> 'header' -> 'batchSizes' -> 0 -> 'quantity';
  v_size  jsonb := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = p_size_id limit 1);
  v_bom   jsonb := case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end;
  v_mbr   text[];
  v_erp   text[];
  m       jsonb;
  e       jsonb;
  dec     constant text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  if btrim(coalesce(p_order_no, '')) = '' then
    return 'a GMP batch is planned against an ERP production order (erpOrder) and names none';
  end if;
  if p_order is null then
    return format('ERP order %s is not in the ERP stub', p_order_no);
  end if;
  if exists (select 1 from recipe.batch_erp_order o where o.order_no = p_order ->> 'orderNo') then
    return format('ERP order %s planned a batch already; an order plans one batch', p_order ->> 'orderNo');
  end if;
  if p_order ->> 'productCode' is distinct from f.product_code or p_order ->> 'strength' is distinct from f.strength then
    return format('ERP order %s is for product %s %s, not for the MBR''s product %s %s', p_order ->> 'orderNo', p_order ->> 'productCode', p_order ->> 'strength',
                  f.product_code, f.strength);
  end if;
  if p_order ->> 'siteCode' is distinct from p_site then
    return format('ERP order %s is for site %s, not %s', p_order ->> 'orderNo', p_order ->> 'siteCode', coalesce(p_site, 'none'));
  end if;
  if v_size is null or coalesce(v_size ->> 'value', '') !~ dec or (p_order ->> 'batchSize')::numeric <> (v_size ->> 'value')::numeric
     or p_order ->> 'batchSizeUnit' is distinct from v_size ->> 'unit' then
    return format('ERP order %s is for a batch of %s %s, not the approved batch size %s (%s %s)', p_order ->> 'orderNo', p_order ->> 'batchSize',
                  p_order ->> 'batchSizeUnit', coalesce(p_size_id, 'none'), coalesce(v_size ->> 'value', '?'), coalesce(v_size ->> 'unit', '?'));
  end if;
  if v_ref is null or coalesce(v_ref ->> 'value', '') !~ dec or (v_ref ->> 'value')::numeric = 0 or v_ref ->> 'unit' is distinct from v_size ->> 'unit' then
    return 'the MBR states no reference batch size its BOM quantities are for';
  end if;
  v_mbr := array(select x ->> 'material' from jsonb_array_elements(v_bom) x order by 1);
  v_erp := array(select x ->> 'materialCode' from jsonb_array_elements(p_order -> 'bom') x order by 1);
  if v_mbr is distinct from v_erp then
    return format('the BOM of ERP order %s holds {%s}, the MBR''s BOM {%s}', p_order ->> 'orderNo', array_to_string(v_erp, ', '), array_to_string(v_mbr, ', '));
  end if;
  for m in select * from jsonb_array_elements(v_bom) loop
    select x into e from jsonb_array_elements(p_order -> 'bom') x where x ->> 'materialCode' = m ->> 'material';
    if coalesce(m -> 'quantity' ->> 'value', '') !~ dec or e ->> 'unit' is distinct from m -> 'quantity' ->> 'unit'
       or (e ->> 'quantity')::numeric * (v_ref ->> 'value')::numeric <> (m -> 'quantity' ->> 'value')::numeric * (v_size ->> 'value')::numeric then
      return format('ERP order %s gives %s %s of %s; the MBR gives %s %s for %s %s, which is %s %s for this batch size', p_order ->> 'orderNo', e ->> 'quantity', e ->> 'unit',
                    m ->> 'material', m -> 'quantity' ->> 'value', m -> 'quantity' ->> 'unit', v_ref ->> 'value', v_ref ->> 'unit',
                    case when (m -> 'quantity' ->> 'value') ~ dec then trim_scale((m -> 'quantity' ->> 'value')::numeric * (v_size ->> 'value')::numeric / (v_ref ->> 'value')::numeric)::text else '?' end,
                    m -> 'quantity' ->> 'unit');
    end if;
  end loop;
  return null;
end
$$;

-- As 0582_packaging_batch_issue.sql; the ERP order matched and recorded after the control recipe is pinned (header).
create or replace function recipe.prepare_gmp_issue(p_batch uuid, p_def jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, site, sandbox, pg_temp as $$
declare
  v_actor   jsonb := recipe.execution_actor('Planning a GMP batch');
  uuid_re   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  zero      constant uuid := '00000000-0000-0000-0000-000000000000';
  f         recipe.mbr_family;
  v_markets text[];
  v_scope   jsonb;
  v_sel     jsonb;
  sz        jsonb;
  v_alloc   uuid;
  v_number  text;
  b         recipe.stub_batch;
  p         recipe.batch_mbr_pin;
  cr        recipe.control_recipe;
  v_parent  recipe.batch_allocation_link;
  v_problem text;
  v_order   jsonb;
begin
  perform sandbox.assert_gmp_installation('Planning a GMP batch');
  perform recipe.require_command_permission('ISSUE', null);
  if p_batch is null or jsonb_typeof(p_def) is distinct from 'object' or coalesce(p_def ->> 'familyId', '') !~ uuid_re then
    raise exception using errcode = 'P0001', message = 'A GMP batch is planned with its id and its MBR family, market set and scope (INV-01). [EBMR-EXE-192]';
  end if;
  select * into f from recipe.mbr_family where id = (p_def ->> 'familyId')::uuid;
  if not found then
    raise exception using errcode = 'P0001', message = format('There is no MBR family %s; a GMP batch is issued only from an effective MBR version (INV-01, DI-05). [EBMR-EXE-192]', p_def ->> 'familyId');
  end if;
  perform iam.require_permission('BATCH.ISSUE', jsonb_strip_nulls(jsonb_build_object('site', p_def ->> 'site', 'product', f.product_code)));
  if exists (select 1 from recipe.stub_batch where id = p_batch) or exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = 'A batch with this id exists already; a batch is planned and issued once (DI-34). [EBMR-EXE-197]';
  end if;
  -- Wait for any market authorisation being activated for this family (INV-17 / INV-01 consistency), as 0170 does.
  perform 1 from recipe.mbr_family where id = f.id for share;
  v_markets := array(select distinct m from jsonb_array_elements_text(case when jsonb_typeof(p_def -> 'markets') = 'array' then p_def -> 'markets' else '[]'::jsonb end) m order by m);
  v_scope := jsonb_build_object('site', p_def ->> 'site', 'line', p_def ->> 'line', 'batch_size', p_def ->> 'batchSize');
  v_sel := recipe.select_version_for_issue(f.id, v_markets, v_scope, clock_timestamp());
  if not (v_sel ->> 'ok')::boolean then
    raise exception using errcode = 'P0001',
      message = format('The GMP batch cannot be planned: %s. A GMP batch is issued only from an effective MBR version (INV-01, INV-28, PR-04, DI-05). [EBMR-EXE-192]', v_sel ->> 'explanation');
  end if;
  -- D-S4-2: a packaging order names the issued processing batch it packs; a processing batch names none.
  if f.record_kind = 'PACKAGING' then
    if coalesce(p_def ->> 'parentBatch', '') !~ uuid_re then
      raise exception using errcode = 'P0001',
        message = 'A packaging order is planned with the processing batch it packs (parentBatch): its number comes from the register as a packaging number of that batch (D-S4-2, INV-27, IN-18). [EBMR-EXE-198]';
    end if;
    select l.* into v_parent from recipe.batch_allocation_link l where l.batch_id = (p_def ->> 'parentBatch')::uuid;
    v_problem := recipe.packaging_parent_problem(f.product_code, p_def ->> 'site', (p_def ->> 'parentBatch')::uuid);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('The packaging order cannot be planned: %s (D-S4-2, INV-27). [EBMR-EXE-198]', v_problem);
    end if;
  elsif p_def ? 'parentBatch' then
    raise exception using errcode = 'P0001', message = 'A processing batch names no parent batch; only a packaging order does (D-S4-2). [EBMR-EXE-198]';
  end if;
  if p_def ? 'allocationId' then
    if coalesce(p_def ->> 'allocationId', '') !~ uuid_re then
      raise exception using errcode = 'P0001', message = 'The batch number names no allocation of the site''s register (INV-27, IN-18). [EBMR-EXE-191]';
    end if;
    select a.id, a.batch_number into v_alloc, v_number from site.batch_number_allocation a where a.id = (p_def ->> 'allocationId')::uuid for update;
    if v_alloc is null then
      raise exception using errcode = 'P0001', message = format('Allocation %s is not in the site''s batch-number register (INV-27, IN-18). [EBMR-EXE-191]', p_def ->> 'allocationId');
    end if;
    if f.record_kind = 'PACKAGING'
       and (select a.parent_allocation_id from site.batch_number_allocation a where a.id = v_alloc) is distinct from v_parent.allocation_id then
      raise exception using errcode = 'P0001',
        message = format('Batch number %s is not a packaging number of batch %s, which this packaging order packs (D-S4-2, INV-27). [EBMR-EXE-198]', v_number, v_parent.batch_number);
    end if;
    if exists (select 1 from recipe.batch_allocation_link l where l.allocation_id = v_alloc or l.batch_number = v_number) then
      raise exception using errcode = 'P0001',
        message = format('Batch number %s was given to a batch already; a batch number is never reused (INV-27, IN-18). [EBMR-EXE-191]', v_number);
    end if;
  else
    sz := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = p_def ->> 'batchSize' limit 1);
    select a.allocation_id, a.batch_number into v_alloc, v_number
      from site.allocate_batch_number(jsonb_build_object('site_code', p_def ->> 'site', 'product_code', f.product_code, 'product_name', f.product_name,
                                                         'edition', upper(f.edition), 'batch_kind', f.record_kind,
                                                         'batch_size', sz ->> 'value', 'batch_size_unit', sz ->> 'unit')
                                      || case when f.record_kind = 'PACKAGING' then jsonb_build_object('parent_batch_number', v_parent.batch_number) else '{}'::jsonb end) a;
  end if;
  insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
  values (p_batch, v_number, f.id, v_markets, p_def ->> 'site', p_def ->> 'line', p_def ->> 'batchSize', zero, zero)
  returning * into b;
  insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
  values (b.id, v_alloc, v_number, zero, zero, zero);
  insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id)
  values (b.id, b.family_id, null, 0, repeat('0', 64), '{}', '{}', '{}', '{}', zero, zero)
  returning * into p;
  insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
  values (b.id, p.id, p.version_id, p.content_hash, '{}', repeat('0', 64), zero, zero)
  returning * into cr;
  -- D-S4-ERP (slice 5a, D-S5-4; outline 5.2.2): the named ERP order matches the pinned MBR: product, strength, site,
  -- batch size and BOM (each material once, quantities scaled to this batch size, exact decimals).
  v_order := site.erp_order_of(p_def ->> 'erpOrder');
  v_problem := recipe.erp_order_problem(p_def ->> 'erpOrder', v_order, f, p_def ->> 'site', p_def ->> 'batchSize', cr.snapshot -> 'mbr' -> 'content');
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('The GMP batch cannot be planned: %s (outline 5.2.2; D-S5-4). [EBMR-EXE-605]', v_problem);
  end if;
  insert into recipe.batch_erp_order (batch_id, order_id, order_no) values (b.id, (v_order ->> 'orderId')::uuid, v_order ->> 'orderNo');
  perform kernel.audit_business_event('batch:' || b.id,
    format('GMP batch %s planned on MBR %s version %s (%s) with batch number %s from the site register (allocation %s), control recipe %s, by %s; issued once signed ISSUED',
           b.batch_number, f.code, p.version_number, p.selection ->> 'rule', v_number, v_alloc, cr.snapshot_hash, coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id, 'content_hash', p.content_hash, 'control_recipe_id', cr.id,
                       'snapshot_hash', cr.snapshot_hash));
  return jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id,
                            'version_number', p.version_number, 'content_hash', p.content_hash, 'rule', p.selection ->> 'rule', 'markets', to_jsonb(p.markets),
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash, 'erp_order', v_order ->> 'orderNo');
end
$$;

-- The open ERP order (not yet planned) a batch of family p_family at site p_site and approved size p_size would be
-- planned against: the oldest whose product, strength, site and size match (its BOM is matched at planning). NULL when
-- none. For a planning screen that does not name one; the planning itself always checks the order it is given.
create function recipe.open_erp_order_for(p_family uuid, p_site text, p_size text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select o.order_no
    from recipe.mbr_family f
    cross join lateral (select x -> 'quantity' as q from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = p_size limit 1) sz
    join site.erp_production_order o on o.product_code = f.product_code and o.strength = f.strength and o.site_code = p_site
                                    and o.batch_size_unit = sz.q ->> 'unit'
   where f.id = p_family
     and (sz.q ->> 'value') ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$' and o.batch_size = (sz.q ->> 'value')::numeric
     and o.id = (select (site.erp_order_of(o.order_no) ->> 'orderId')::uuid)
     and not exists (select 1 from recipe.batch_erp_order b where b.order_no = o.order_no)
   order by o.received_at, o.order_no limit 1
$$;

revoke all on function recipe.erp_order_problem(text, jsonb, recipe.mbr_family, text, text, jsonb) from public;
grant execute on function recipe.open_erp_order_for(uuid, text, text) to ebmr_app;
revoke all on recipe.batch_erp_order from ebmr_app;
grant select on recipe.batch_erp_order to ebmr_app;

reset role;
