-- Recipe core: the product-master flag of controlled-substance mode (Phase 6 slice 6e; draft control IN-53; defaults
-- D-P6e-6, D-P6e-9; docs/build-plan/phase-6/slice-6e-0-interfaces.md).
--
-- Handbook: modules/recipe-core.md
--
--   plant.controlled_product           insert-only: QA's record that a product contains a controlled substance (or no
--                                      longer does), the controlled API materials it names and the basis (licence or
--                                      quota reference). A configuration area (CONTROLLED_PRODUCT, kernel 1195): every
--                                      record needs an approved change record covering it in the command (DI-09), and
--                                      its history is a read of platform.config_version.
--   plant.controlled_product_approval  a second QA person's CONTROLLED_PRODUCT_APPROVED signature over one record, never
--                                      by its recorder; only the latest record of the product, once.
-- In effect (fail-safe, as the hazard class of 0912: an unsigned record can only add restrictions, never lift one):
--   plant.controlled_materials(product) text[]  the materials of the latest approved record when it is controlled, plus
--       those of every later record not yet approved that is controlled. A pending unflagging counts only once approved.
--       '{}' for a product with no record: an unflagged product is unaffected.
--   plant.material_is_controlled(material)      some product in effect lists the material (D-P6e-6: the stores treat it
--       as controlled).
--   plant.controlled_product_state(product)     the screens' view: in effect, the approved record, the pending ones.
-- Commands (never an administrator, the permission first): plant.record_controlled_product(p) CONTROLLED.RECORD,
-- plant.approve_controlled_product(record, signature) CONTROLLED.APPROVE. Signed aggregate: controlled_product <record
-- id>, state RECORDED (APPROVED or SUPERSEDED after). Messages: EBMR-CSM-001 to EBMR-CSM-009.

set local role ebmr_owner;

create table plant.controlled_product (
  id                     uuid primary key default gen_random_uuid(),
  product_code           text not null check (product_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  controlled             boolean not null,
  material_codes         text[] not null,
  basis_ref              text not null check (btrim(basis_ref) <> '' and length(basis_ref) <= 200),
  recorded_by_person     uuid not null,
  recorded_by_account    uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  correlation_id         uuid not null,
  check (controlled = (cardinality(material_codes) > 0)),
  check (cardinality(material_codes) <= 20)
);
create index controlled_product_key on plant.controlled_product (product_code, recorded_at desc);
revoke all on plant.controlled_product from public;

create table plant.controlled_product_approval (
  record_id            uuid primary key references plant.controlled_product (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on plant.controlled_product_approval from public;

select platform.enforce_db_time('plant.controlled_product', array['recorded_at']);
select platform.enforce_db_time('plant.controlled_product_approval', array['approved_at']);
select kernel.register_audited_table('plant.controlled_product', 'controlled_product', 'id', true);
select kernel.register_audited_table('plant.controlled_product_approval', 'controlled_product', 'record_id', true);
create trigger zz_immutable before update or delete on plant.controlled_product for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on plant.controlled_product_approval for each row execute function site.india_record_immutable();

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1031_controlled_product_flag)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the controlled-substance flag of a product is a configuration record under change control (IN-53, DI-09)'));
select platform.register_config_area('CONTROLLED_PRODUCT', 'plant.controlled_product',
  'Controlled-substance flags of products and the controlled API materials they name (IN-53, draft)',
  array['product_code'], array['controlled', 'material_codes', 'basis_ref'], 'recorded_at', 'recorded_at');
select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function plant.controlled_product_approved(p_product text) returns plant.controlled_product
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select r.* from plant.controlled_product r join plant.controlled_product_approval a on a.record_id = r.id
   where r.product_code = p_product order by r.recorded_at desc, r.id desc limit 1
$$;

create function plant.controlled_materials(p_product text) returns text[]
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with a as (select (plant.controlled_product_approved(p_product)).*)
  select coalesce(array_agg(distinct m order by m), '{}') from (
    select unnest(a.material_codes) as m from a where a.id is not null and a.controlled
    union all
    select unnest(r.material_codes) from plant.controlled_product r
     where r.product_code = p_product and r.controlled
       and not exists (select 1 from plant.controlled_product_approval x where x.record_id = r.id)
       and (not exists (select 1 from a where a.id is not null) or (r.recorded_at, r.id) > ((select a.recorded_at from a), (select a.id from a)))) y
$$;

create function plant.material_is_controlled(p_material text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select exists (select 1 from (select distinct r.product_code from plant.controlled_product r where p_material = any (r.material_codes)) p
                  where p_material = any (plant.controlled_materials(p.product_code)))
$$;

create function plant.controlled_record_state(p_record uuid) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.controlled_product_approval a where a.record_id = r.id) then 'APPROVED'
              when exists (select 1 from plant.controlled_product l where l.product_code = r.product_code and (l.recorded_at, l.id) > (r.recorded_at, r.id)) then 'SUPERSEDED'
              else 'RECORDED' end
    from plant.controlled_product r where r.id = p_record
$$;

create function plant.controlled_product_state(p_product text) returns jsonb
language sql stable security definer set search_path = pg_catalog, plant, site, pg_temp as $$
  select jsonb_build_object(
    'productCode', p_product,
    'materialsInEffect', to_jsonb(plant.controlled_materials(p_product)),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
        'recordId', r.id, 'controlled', r.controlled, 'materialCodes', to_jsonb(r.material_codes), 'basisRef', r.basis_ref,
        'recordedBy', r.recorded_by_person, 'recordedAt', site.utc_text(r.recorded_at), 'state', plant.controlled_record_state(r.id),
        'approvedBy', a.approved_by_person, 'approvedAt', case when a.record_id is null then null else site.utc_text(a.approved_at) end)
        order by r.recorded_at desc, r.id desc)
      from plant.controlled_product r left join plant.controlled_product_approval a on a.record_id = r.id
     where r.product_code = p_product), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content
-- ---------------------------------------------------------------------------------------------

create function plant.controlled_product_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, site, pg_temp as $$
declare
  r plant.controlled_product;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into r from plant.controlled_product where id = p_id::uuid;
  if r.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('title', format('%s: %s', r.product_code, case when r.controlled then 'controlled substance' else 'not controlled' end),
                                  'product_code', r.product_code, 'controlled', r.controlled, 'material_codes', to_jsonb(r.material_codes),
                                  'basis', r.basis_ref,
                                  'recorded_by', r.recorded_by_person, 'recorded_at', site.utc_text(r.recorded_at),
                                  'status_note', 'Draft control IN-53: NDPS Act and Rules not verified'),
    'state', plant.controlled_record_state(r.id),
    'scope', jsonb_build_object('product', r.product_code),
    'entered_by', jsonb_build_array(r.recorded_by_person));
end
$$;

select esig.register_content_provider('controlled_product', 'plant.controlled_product_content(text)',
  'A product''s controlled-substance flag and its controlled API materials, approved by a second QA person (IN-53, draft)');

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p: {productCode, controlled (boolean), materialCodes (array of material codes; empty when not controlled), basisRef}.
create function plant.record_controlled_product(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, site, iam, pg_temp as $$
declare
  v_ctx  jsonb;
  v_mats text[];
  v_m    text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  v_ctx := iam.require_permission('CONTROLLED.RECORD', jsonb_build_object('product', p ->> 'productCode'));
  if p is null or jsonb_typeof(p -> 'controlled') is distinct from 'boolean' or jsonb_typeof(p -> 'materialCodes') is distinct from 'array'
     or coalesce(btrim(p ->> 'basisRef'), '') = '' or coalesce(p ->> 'productCode', '') !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CSM-001 a controlled-substance flag names the product, whether it is controlled, its controlled API materials and the basis (licence or quota reference) (IN-53)';
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_mats from jsonb_array_elements_text(p -> 'materialCodes') x;
  if (p ->> 'controlled')::boolean <> (cardinality(v_mats) > 0) or cardinality(v_mats) <> jsonb_array_length(p -> 'materialCodes') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CSM-002 a controlled product names each of its controlled API materials once, and a product that is not controlled names none (IN-53)';
  end if;
  foreach v_m in array v_mats loop
    if not exists (select 1 from site.erp_material e where e.material_code = v_m and e.material_kind = 'API') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-CSM-003 %s is no API in the material master: the flag names the controlled API materials (IN-53)', v_m);
    end if;
  end loop;
  perform pg_advisory_xact_lock(hashtext('plant.controlled_product'), hashtext(p ->> 'productCode'));
  insert into plant.controlled_product (product_code, controlled, material_codes, basis_ref, recorded_by_person, recorded_by_account, correlation_id)
  values (p ->> 'productCode', (p ->> 'controlled')::boolean, v_mats, btrim(p ->> 'basisRef'), (v_ctx ->> 'person_id')::uuid,
          (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function plant.approve_controlled_product(p_record uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, esig, iam, pg_temp as $$
declare
  v_ctx  jsonb;
  r      plant.controlled_product;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into r from plant.controlled_product where id = p_record;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-004 unknown controlled-substance flag record %s', coalesce(p_record::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('CONTROLLED.APPROVE', jsonb_build_object('product', r.product_code));
  perform pg_advisory_xact_lock(hashtext('plant.controlled_product'), hashtext(r.product_code));
  if plant.controlled_record_state(r.id) <> 'RECORDED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CSM-005 this flag record of %s is %s; only the latest record of a product is approved, once', r.product_code, plant.controlled_record_state(r.id));
  end if;
  if r.recorded_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-006 a controlled-substance flag is approved by another QA person than its recorder (IN-53, DI-35)';
  end if;
  perform esig.assert_signature(p_signature, 'CONTROLLED_PRODUCT_APPROVED', 'controlled_product', r.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-007 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-007 the approval is recorded by the person who signed it';
  end if;
  insert into plant.controlled_product_approval (record_id, signature_id, approved_by_person, approved_by_account)
  values (r.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

revoke all on function plant.controlled_product_approved(text), plant.controlled_materials(text), plant.material_is_controlled(text),
  plant.controlled_record_state(uuid), plant.controlled_product_state(text), plant.controlled_product_content(text),
  plant.record_controlled_product(jsonb), plant.approve_controlled_product(uuid, uuid) from public;
grant select on plant.controlled_product, plant.controlled_product_approval to ebmr_app;
grant execute on function plant.controlled_materials(text), plant.material_is_controlled(text), plant.controlled_record_state(uuid),
  plant.controlled_product_state(text), plant.record_controlled_product(jsonb), plant.approve_controlled_product(uuid, uuid) to ebmr_app;

reset role;
