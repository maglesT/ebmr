-- Recipe core, Phase 3 slice 4a (builder B; default D-S4-2): a packaging order is a GMP batch of record kind PACKAGING,
-- issued like a processing batch (0500 to 0504), whose number the site's register allocates as a PACKAGING number of
-- the processing batch it packs (site services 0600: a packaging allocation names its parent processing allocation)
-- (controls INV-27, IN-18, IN-16; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
--   * recipe.packaging_parent_problem(product, site, parent): why batch p_parent is not a processing batch a packaging
--     order of product p_product at site p_site may pack: it is an issued GMP batch (recipe.batch_execution, purpose
--     GMP_BATCH) of an MBR of record kind PROCESSING, of the same product (stricter default: a pack carries the batch's
--     product) and site, with its register number linked (0500).
--   * recipe.prepare_gmp_issue, replaced from its latest definition (0501): a packaging order's definition names
--     parentBatch, the issued processing batch it packs; the register then allocates its number as a PACKAGING number of
--     that batch's number (site.allocate_batch_number with parent_batch_number). A processing batch names no parent.
--     Nothing else of it changes.
--   * recipe.packaging_link_guard (trigger a2_packaging_parent on recipe.batch_allocation_link, before insert): the
--     register allocation linked to a planned batch of a PACKAGING family names, as its parent, the allocation of an
--     issued processing batch of the same product and site (the allocationId path of 0501 included, and any direct
--     insert), so a packaging number is never linked without its processing batch (EBMR-EXE-198).
--
-- Messages: EBMR-EXE-198. CREATE OR REPLACE keeps the owner and grants. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- D-S4-2, INV-27 (header).
create function recipe.packaging_parent_problem(p_product text, p_site text, p_parent uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x  recipe.batch_execution;
  sb recipe.stub_batch;
  f  recipe.mbr_family;
begin
  select * into x from recipe.batch_execution where id = p_parent;
  if x.id is null or x.purpose <> 'GMP_BATCH' then
    return format('batch %s is no issued GMP batch', coalesce(p_parent::text, '(none)'));
  end if;
  select * into sb from recipe.stub_batch where id = p_parent;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if f.record_kind is distinct from 'PROCESSING' then
    return format('batch %s is no processing batch', x.batch_number);
  end if;
  if f.product_code is distinct from p_product or sb.site is distinct from p_site then
    return format('batch %s is of product %s at site %s, not of %s at %s', x.batch_number, f.product_code, sb.site, coalesce(p_product, '(none)'), coalesce(p_site, '(none)'));
  end if;
  if not exists (select 1 from recipe.batch_allocation_link l where l.batch_id = p_parent) then
    return format('batch %s has no register number', x.batch_number);
  end if;
  return null;
end
$$;

-- D-S4-2, INV-27 (header).
create function recipe.packaging_link_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  a    site.batch_number_allocation;
  sb   recipe.stub_batch;
  f    recipe.mbr_family;
  v_pb uuid;
  v_p  text;
begin
  select * into sb from recipe.stub_batch where id = new.batch_id;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if f.record_kind is distinct from 'PACKAGING' then
    return new;
  end if;
  select * into a from site.batch_number_allocation where id = new.allocation_id;
  select l.batch_id into v_pb from recipe.batch_allocation_link l where l.allocation_id = a.parent_allocation_id;
  v_p := case when a.parent_allocation_id is null then 'its register number names no processing batch'
              when v_pb is null then 'its register number names a processing number no batch was issued with'
              else recipe.packaging_parent_problem(f.product_code, sb.site, v_pb) end;
  if v_p is not null then
    raise exception using errcode = 'P0001',
      message = format('Packaging order %s cannot take batch number %s: %s; a packaging number is allocated for an issued processing batch of the same product and site (D-S4-2, INV-27, IN-18). [EBMR-EXE-198]',
                       sb.batch_number, new.batch_number, v_p);
  end if;
  return new;
end
$$;

create trigger a2_packaging_parent before insert on recipe.batch_allocation_link for each row execute function recipe.packaging_link_guard();

-- As 0501, with the parent batch of a packaging order (header).
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
  perform kernel.audit_business_event('batch:' || b.id,
    format('GMP batch %s planned on MBR %s version %s (%s) with batch number %s from the site register (allocation %s), control recipe %s, by %s; issued once signed ISSUED',
           b.batch_number, f.code, p.version_number, p.selection ->> 'rule', v_number, v_alloc, cr.snapshot_hash, coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id, 'content_hash', p.content_hash, 'control_recipe_id', cr.id,
                       'snapshot_hash', cr.snapshot_hash));
  return jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id,
                            'version_number', p.version_number, 'content_hash', p.content_hash, 'rule', p.selection ->> 'rule', 'markets', to_jsonb(p.markets),
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash);
end
$$;

revoke all on function recipe.packaging_parent_problem(text, text, uuid), recipe.packaging_link_guard() from public;

reset role;
