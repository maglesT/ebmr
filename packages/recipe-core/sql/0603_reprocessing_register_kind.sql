-- Recipe core: a whole-batch reprocessing batch takes a PROCESSING number from the site register (Phase 3 slice 5a, fix
-- for slice 5b's MBR record kind REPROCESSING, recipe-core 0624; D-S5-6: the child takes an ordinary PROCESSING number,
-- never the parent's; INV-33, IN-18).
--
-- The site register knows batch kinds PROCESSING and PACKAGING only; the reprocessing link to the parents lives in the
-- batch side's genealogy (recipe.batch_parent_link), so the register needs no new kind. recipe.register_batch_kind maps
-- an MBR record kind to the register's batch kind (PACKAGING stays PACKAGING, PROCESSING and REPROCESSING are
-- PROCESSING). Replaced from their latest definitions with that one change:
--   * recipe.allocation_problem (0500): the allocation's batch kind is compared with the mapped kind;
--   * recipe.prepare_gmp_issue (0602): the register is asked for the mapped kind.
-- Nothing else changes. CREATE OR REPLACE keeps owners and grants.

set local role ebmr_owner;

create function recipe.register_batch_kind(p_record_kind text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_record_kind when 'PACKAGING' then 'PACKAGING' when 'PROCESSING' then 'PROCESSING' when 'REPROCESSING' then 'PROCESSING' end
$$;

-- As 0500_gmp_batch_store.sql; the record kind mapped to the register's batch kind (header).
create or replace function recipe.allocation_problem(p_batch uuid, p_allocation uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b  recipe.stub_batch;
  f  recipe.mbr_family;
  a  site.batch_number_allocation;
  sz jsonb;
begin
  select * into b from recipe.stub_batch where id = p_batch;
  select * into a from site.batch_number_allocation where id = p_allocation;
  if b.id is null then
    return 'the batch is not planned';
  end if;
  if a.id is null then
    return format('allocation %s is not in the site''s batch-number register', p_allocation);
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  sz := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = b.batch_size limit 1);
  if exists (select 1 from site.batch_number_void v where v.allocation_id = a.id) then
    return format('batch number %s was voided in the register; a voided number is never issued', a.batch_number);
  end if;
  if a.batch_number is distinct from b.batch_number then
    return format('the register allocated %s, not %s', a.batch_number, b.batch_number);
  end if;
  if a.site_code is distinct from b.site or a.product_code is distinct from f.product_code or a.edition is distinct from upper(f.edition)
     or a.batch_kind is distinct from recipe.register_batch_kind(f.record_kind) then
    return format('batch number %s was allocated for %s %s %s at site %s, not for %s %s %s at site %s', a.batch_number, a.edition, a.batch_kind, a.product_code,
                  a.site_code, upper(f.edition), f.record_kind, f.product_code, b.site);
  end if;
  if sz is null or a.batch_size is distinct from (case when (sz ->> 'value') ~ '^[0-9]+(\.[0-9]+)?$' then (sz ->> 'value')::numeric end)
     or a.batch_size_unit is distinct from sz ->> 'unit' then
    return format('batch number %s was allocated for a batch of %s %s, not for the batch size %s of the batch', a.batch_number, a.batch_size, a.batch_size_unit, b.batch_size);
  end if;
  return null;
end
$$;

-- As 0602_gmp_issue_erp_order.sql; the register asked for the mapped batch kind (header).
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
                                                         'edition', upper(f.edition), 'batch_kind', recipe.register_batch_kind(f.record_kind),
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

reset role;
