-- ERP stub, part 2: the material master, and receipt from it (Phase 3 slice 5a step 4; slice 5 plan D-S5-3, D-S5-4;
-- outline 4.6, 5.2.9; backlog slice 1 #7; controls PR-17, IN-24 (a)).
--
--   site.erp_material                insert-only versions written by the ERP interface; the latest version of a
--                                    material code wins: name, kind, stock unit and the maximum retest interval in
--                                    months (NULL: the material has no retest date; the retest rule of 0752 reads it)
--   site.erp_receive_material(p)     INTERFACE.WRITE (role ERP_INTERFACE)
--   site.material_master_of(code)    {materialName, materialKind, unit, maxRetestMonths} or NULL
--   site.receive_lot                 replaced from its latest definition (0712): the kind, name and unit come from the
--                                    material master. An unknown material is refused; a receipt that states another
--                                    kind, name or unit than the master is refused (so a purchased material never
--                                    arrives as INTERMEDIATE, and no lot carries a typed name). Everything else as 0712.
-- Messages: EBMR-SITE-170 to 174.

set local role ebmr_owner;

create table site.erp_material (
  id                   uuid primary key default gen_random_uuid(),
  material_code        text not null check (material_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  material_name        text not null check (btrim(material_name) <> '' and length(material_name) <= 200),
  material_kind        text not null check (material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED')),
  unit                 text not null check (unit ~ '^[!-~]{1,32}$'),
  max_retest_months    integer check (max_retest_months between 1 and 120),
  erp_reference        text not null check (btrim(erp_reference) <> '' and length(erp_reference) <= 64),
  received_by_person   uuid not null,
  received_by_account  uuid not null,
  received_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index erp_material_code on site.erp_material (material_code, received_at desc);
revoke all on site.erp_material from public;

select platform.enforce_db_time('site.erp_material', array['received_at']);
select kernel.register_audited_table('site.erp_material', 'erp_material', 'id', true);

-- p: {materialCode, materialName, materialKind, unit, maxRetestMonths?, erpReference}
create function site.erp_receive_material(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p is null or jsonb_typeof(p) <> 'object'
     or (p ? 'maxRetestMonths' and coalesce(p ->> 'maxRetestMonths', '') !~ '^[1-9][0-9]{0,2}$') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-170 a material master row names the material, its name, kind and stock unit, the maximum retest interval in whole months if it has one, and the ERP reference (D-S5-4)';
  end if;
  insert into site.erp_material (material_code, material_name, material_kind, unit, max_retest_months, erp_reference, received_by_person, received_by_account, correlation_id)
  values (p ->> 'materialCode', p ->> 'materialName', p ->> 'materialKind', p ->> 'unit', (p ->> 'maxRetestMonths')::integer, p ->> 'erpReference',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.erp_material_current(p_code text) returns site.erp_material
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select m.* from site.erp_material m where m.material_code = p_code order by m.received_at desc, m.id desc limit 1
$$;

create function site.material_master_of(p_code text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('materialName', m.material_name, 'materialKind', m.material_kind, 'unit', m.unit, 'maxRetestMonths', m.max_retest_months)
  from site.erp_material m where m.material_code = p_code order by m.received_at desc, m.id desc limit 1
$$;

-- As 0712_material_lot_commands.sql; the kind, name and unit from the material master (header).
-- p: {lotCode, materialCode, quantity (decimal text), retestAt?, expiresAt, supplier?, supplierLot?, and optionally
--     materialName, materialKind, unit, which must be the master's}
create or replace function site.receive_lot(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, kernel, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_site  text;
  v_id    uuid := gen_random_uuid();
  v_qty   numeric;
  v_kind  text;
  v_state jsonb;
  m       site.erp_material;
begin
  perform iam.assert_not_administrator();
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-103 the lot details are required';
  end if;
  v_site := site.actor_site();
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_site));
  m := site.erp_material_current(p ->> 'materialCode');
  if m.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-171 material %s is not in the ERP material master; a lot is received only for a known material (PR-17)', coalesce(p ->> 'materialCode', 'NULL'));
  end if;
  if (p ? 'materialKind' and p ->> 'materialKind' is distinct from m.material_kind)
     or (p ? 'materialName' and p ->> 'materialName' is distinct from m.material_name)
     or (p ? 'unit' and p ->> 'unit' is distinct from m.unit) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-172 material %s is %s "%s" in %s in the material master; a receipt takes the kind, name and unit from it (PR-17, IN-24 (a))',
                       m.material_code, m.material_kind, m.material_name, m.unit);
  end if;
  v_kind := m.material_kind;
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-103 the received quantity is a positive decimal (INV-13)';
  end if;
  v_qty := (p ->> 'quantity')::numeric;
  if coalesce((p ->> 'expiresAt')::timestamptz <= clock_timestamp(), true) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-104 a lot is received with an expiry instant in the future (PR-18)';
  end if;
  -- One material, one kind: the vendor-history rule is per material and depends on its kind.
  if exists (select 1 from site.material_lot l where l.site_code = v_site and l.material_code = m.material_code and l.material_kind <> v_kind)
     or (v_kind is distinct from 'EXCIPIENT'
         and exists (select 1 from site.vendor_route v where v.site_code = v_site and v.material_code = m.material_code)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-105 material %s is already known at site %s as another kind than %s', m.material_code, v_site, coalesce(v_kind, 'NULL'));
  end if;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, supplier_lot, received_quantity,
                                 unit, retest_at, expires_at, received_by_person, received_by_account, correlation_id)
  values (v_id, v_site, p ->> 'lotCode', m.material_code, m.material_name, v_kind, p ->> 'supplier', p ->> 'supplierLot', v_qty,
          m.unit, (p ->> 'retestAt')::timestamptz, (p ->> 'expiresAt')::timestamptz, (v_ctx ->> 'person_id')::uuid,
          (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  v_state := platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return jsonb_build_object('lot_id', v_id, 'site_code', v_site, 'state', v_state ->> 'state', 'state_version', (v_state ->> 'version')::bigint);
end
$$;

revoke all on site.erp_material from ebmr_app;
grant select on site.erp_material to ebmr_app;
grant execute on function site.erp_receive_material(jsonb), site.material_master_of(text) to ebmr_app;

reset role;
