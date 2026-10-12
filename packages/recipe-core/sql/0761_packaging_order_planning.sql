-- Recipe core, Phase 4 slice 2c: planning a packaging order (outline 5.2.2, 5.2.9; controls INV-27, IN-18, IN-16,
-- PR-37; review backlog 2b #4 and the Phase 3 exit residual "no route plans a packaging order").
--
--   * recipe.packaging_completion_block: per edition, the block types that complete a packaging record (tablets: TB-24,
--     secondary packaging with the finished-pack examination and SSCC aggregation). Owner-written, read by the planning
--     check; an edition with no row plans no packaging order (fails closed).
--   * recipe.packaging_master_problem(edition, content): why a packaging master does not pack to the end: its procedure
--     holds no step of a completion block of its edition. NULL when it does.
--   * recipe.prepare_gmp_issue, replaced from its latest definition (0603) with three changes:
--       - a packaging order is refused when its pinned master has no completion block (EBMR-PLN-005);
--       - a number allocated ahead (allocationId) is taken only by the person who allocated it (EBMR-PLN-004; backlog
--         2b #4: it accepted an allocation made earlier by another person);
--       - the number's test-data check (sandbox.assert_identifier_allowed) runs at planning, not only at issue.
--     Nothing else changes. CREATE OR REPLACE keeps the owner and grants.
--
-- Messages: EBMR-PLN-004, EBMR-PLN-005.

set local role ebmr_owner;

create table recipe.packaging_completion_block (
  edition     text not null check (edition in ('tablets', 'injectables')),
  block_type  text not null check (block_type ~ '^(G|TB|IB)-[0-9]{2}$'),
  primary key (edition, block_type)
);
revoke all on recipe.packaging_completion_block from public;
insert into recipe.packaging_completion_block (edition, block_type) values ('tablets', 'TB-24');
-- Audited and insert-only like every recipe table (ADR 0012): a later edition's row is a migration's, recorded in the trail.
select kernel.register_audited_table('recipe.packaging_completion_block', 'packaging_completion_block', 'edition', true);
grant select on recipe.packaging_completion_block to ebmr_app;

create function recipe.packaging_master_problem(p_edition text, p_content jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_types text[] := array(select b.block_type from recipe.packaging_completion_block b where b.edition = p_edition order by b.block_type);
begin
  if cardinality(v_types) = 0 then
    return format('no block completes a packaging record of the %s edition yet', coalesce(p_edition, '(none)'));
  end if;
  if not exists (select 1 from jsonb_path_query(coalesce(p_content -> 'procedure', 'null'::jsonb), 'lax $.**.block.type') t
                  where t #>> '{}' = any (v_types)) then
    return format('its procedure has no %s step: a packaging record ends with the secondary packaging of the finished packs', array_to_string(v_types, ' or '));
  end if;
  return null;
end
$$;

-- As 0603_reprocessing_register_kind.sql, with the three changes of the header.
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
  -- Phase 4 slice 2c: a packaging order is planned only on a master that packs to the end (the edition's secondary
  -- packaging block, tablets TB-24: examined finished packs, shippers and their SSCCs).
  if f.record_kind = 'PACKAGING' then
    v_problem := recipe.packaging_master_problem(f.edition, (recipe.current_content((v_sel ->> 'version_id')::uuid)).content);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLN-005 the packaging order cannot be planned on MBR %s version %s: %s (outline 5.2.9; PR-37, IN-16)', f.code, v_sel ->> 'version_number', v_problem);
    end if;
  end if;
  if p_def ? 'allocationId' then
    if coalesce(p_def ->> 'allocationId', '') !~ uuid_re then
      raise exception using errcode = 'P0001', message = 'The batch number names no allocation of the site''s register (INV-27, IN-18). [EBMR-EXE-191]';
    end if;
    select a.id, a.batch_number into v_alloc, v_number from site.batch_number_allocation a where a.id = (p_def ->> 'allocationId')::uuid for update;
    if v_alloc is null then
      raise exception using errcode = 'P0001', message = format('Allocation %s is not in the site''s batch-number register (INV-27, IN-18). [EBMR-EXE-191]', p_def ->> 'allocationId');
    end if;
    -- Review backlog 2b #4: a number allocated ahead is taken only by the person who allocated it (who held
    -- BATCH_NUMBER.ALLOCATE for it); another planner allocates a number of their own.
    if (select a.allocated_by_person_id from site.batch_number_allocation a where a.id = v_alloc) is distinct from (v_actor ->> 'person_id')::uuid then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLN-004 batch number %s was allocated by another person; a number allocated ahead is planned only by the person who allocated it (INV-27, IN-18, DI-14)', v_number);
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
  -- Review backlog 2b #4: the number's test-data check runs at planning too, not only at issue (DI-05, INV-18).
  perform sandbox.assert_identifier_allowed('BATCH_NUMBER', v_number);
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

revoke all on function recipe.packaging_master_problem(text, jsonb) from public;
grant execute on function recipe.packaging_master_problem(text, jsonb) to ebmr_app;

reset role;
