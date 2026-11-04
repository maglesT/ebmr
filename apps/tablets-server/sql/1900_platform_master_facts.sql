-- Phase B slice 3 (docs/build-plan/phase-b/platform-move-plan.md, "Guard facts"; approved by the lead on 3 Nov 2026):
-- master data through the platform's versioned views, with the write-time active-item check (PL-08) trusted and
-- database-side. On the platform build the server reads the item through the master view, on its own login, in the
-- request that writes, and records what it read here in the same transaction; the database refuses a write whose
-- master item has no such fact, or whose fact says the item is unknown or inactive. The standalone build is unchanged.
--
-- Handbook: modules/kernel.md (platform build)
--
--   md.item_map        insert-only id map: this installation's local code of an item ↔ the master item's id. The first active
--                      fact links them (the master code then equals the local code); a later rename at core keeps the
--                      link, so records keep their own code (PL-07).
--   md.master_fact     insert-only evidence of each write-time read: the item as the master view gave it (id, code,
--                      name, version, active), in which transaction, by whom. Not a master list (D-02).
--   md.record_fact(kind, local_code, master_id, code, name, version, active)
--                      ebmr_app only: records the server's read in the writing transaction. master_id null: the view has
--                      no such item. Refused when the read names another master item than the id map (EBMR-MD-002).
--   md.require_active(kind, local_code)
--                      on the platform build: refused unless a fact recorded in this transaction says the item is active
--                      and matches the id map (EBMR-MD-001). Without any fact it raises SQLSTATE EBM01 with the kind and
--                      the code (and the mapped master id) as detail: the server reads the item and runs the command again.
--   Write paths (before insert, platform build only): plant.product, plant.area (ROOM), plant.equipment (equipment or
--   instrument), site.erp_material and received material lots, equipment and instrument use, a RECORD_ENTRY command
--   naming a received material lot (its material), and the batch issue (recipe.require_issue_permission: the product).
--   Every guarded table is insert-only (aa_insert_only_*), so the check at insert covers every write.
--
-- Accepted limits (review of slice 3):
--   * the fact is the server's read on the master link just before the write commits, not the same snapshot (two
--     databases); it keeps the read time (read_at), and core's change after that read applies to the next write;
--   * md.record_fact trusts ebmr_app (the server), as the plan says; the browser never supplies a fact;
--   * an entry is matched on any string that is a received lot's whole code (every block names its lots by code); a
--     remark that is exactly such a code is checked too, which can only refuse when that material is inactive at core.

create schema md authorization ebmr_owner;
revoke all on schema md from public;

set local role ebmr_owner;

grant usage on schema md to ebmr_app;

create table md.item_map (
  kind        text not null check (kind in ('product', 'room', 'equipment', 'instrument', 'material')),
  local_code  text not null check (btrim(local_code) <> ''),
  master_id   text not null check (btrim(master_id) <> '' and length(master_id) <= 128),
  linked_at   timestamptz not null default clock_timestamp(),
  primary key (kind, local_code),
  unique (kind, master_id)
);
select iam.protect_log('md.item_map');

create table md.master_fact (
  id          uuid primary key default gen_random_uuid(),
  xact_id     xid8 not null default pg_current_xact_id(),
  kind        text not null check (kind in ('product', 'room', 'equipment', 'instrument', 'material')),
  local_code  text not null check (btrim(local_code) <> ''),
  master_id   text check (master_id is null or btrim(master_id) <> ''),
  code        text,
  name        text,
  version     text,
  active      boolean not null,
  person_id   uuid,
  read_at     timestamptz not null default clock_timestamp(),
  check (master_id is not null or not active)
);
select iam.protect_log('md.master_fact');
create index master_fact_by_xact on md.master_fact (xact_id, kind, local_code);

create function md.record_fact(p_kind text, p_local_code text, p_master_id text, p_code text, p_name text, p_version text, p_active boolean)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, md, kernel, pg_temp as $$
declare
  v_mapped text;
  v_local  text;
begin
  select master_id into v_mapped from md.item_map where kind = p_kind and local_code = p_local_code;
  select local_code into v_local from md.item_map where kind = p_kind and master_id = p_master_id;
  if (v_mapped is not null and p_master_id is not null and v_mapped <> p_master_id)
     or (v_local is not null and v_local <> p_local_code) then
    raise exception using errcode = 'P0001',
      message = format('The %s %s is linked to another master item than the one read; ask your administrator. [EBMR-MD-002]', p_kind, p_local_code);
  end if;
  if v_mapped is null and p_master_id is not null and p_active then
    if p_code is distinct from p_local_code then
      raise exception using errcode = 'P0001',
        message = format('The %s %s is not linked to master data: the master code is %s. [EBMR-MD-002]', p_kind, p_local_code, coalesce(p_code, 'none'));
    end if;
    insert into md.item_map (kind, local_code, master_id) values (p_kind, p_local_code, p_master_id);
  end if;
  insert into md.master_fact (kind, local_code, master_id, code, name, version, active, person_id)
  values (p_kind, p_local_code, p_master_id, p_code, p_name, p_version, p_active and p_master_id is not null,
          nullif(kernel.current_actor() ->> 'person_id', '')::uuid);
end
$$;

create function md.require_active(p_kind text, p_local_code text) returns void
language plpgsql stable security definer set search_path = pg_catalog, md, iam, pg_temp as $$
declare
  v_fact   md.master_fact;
  v_mapped text;
begin
  if not iam.platform_build() then
    return;
  end if;
  select master_id into v_mapped from md.item_map where kind = p_kind and local_code = p_local_code;
  select * into v_fact from md.master_fact
   where xact_id = pg_current_xact_id_if_assigned() and kind = p_kind and local_code = p_local_code
   order by read_at desc limit 1;
  if v_fact.id is null then
    raise exception using errcode = 'EBM01',
      message = format('The write needs the master data of %s %s. [EBMR-MD-000]', p_kind, p_local_code),
      detail = jsonb_strip_nulls(jsonb_build_object('kind', p_kind, 'code', p_local_code, 'masterId', v_mapped))::text;
  end if;
  if not v_fact.active or v_mapped is null or v_fact.master_id is distinct from v_mapped then
    raise exception using errcode = 'P0001',
      message = format('No such active %s: %s. [EBMR-MD-001]', p_kind, p_local_code);
  end if;
end
$$;

-- The write paths -------------------------------------------------------------------------------

create function md.require_active_row() returns trigger
language plpgsql security definer set search_path = pg_catalog, md, plant, site, iam, pg_temp as $$
begin
  if not iam.platform_build() then
    return new;
  end if;
  case tg_table_schema || '.' || tg_table_name
    when 'plant.product' then
      perform md.require_active('product', new.code);
    when 'plant.area' then
      if new.kind = 'ROOM' then
        perform md.require_active('room', new.code);
      end if;
    when 'plant.equipment' then
      perform md.require_active(case when new.kind = 'INSTRUMENT' then 'instrument' else 'equipment' end, new.code);
    when 'plant.equipment_use', 'plant.instrument_use' then
      perform md.require_active(case when e.kind = 'INSTRUMENT' then 'instrument' else 'equipment' end, e.code)
         from plant.equipment e where e.id = new.equipment_id;
    when 'site.erp_material' then
      perform md.require_active('material', new.material_code);
    when 'site.material_lot' then
      -- Received materials only: a batch's own intermediate or finished output is no master material.
      if new.material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING') then
        perform md.require_active('material', new.material_code);
      end if;
  end case;
  return new;
end
$$;

create trigger ab_md_active_product before insert on plant.product for each row execute function md.require_active_row();
create trigger ab_md_active_area before insert on plant.area for each row execute function md.require_active_row();
create trigger ab_md_active_equipment before insert on plant.equipment for each row execute function md.require_active_row();
create trigger ab_md_active_equipment_use before insert on plant.equipment_use for each row execute function md.require_active_row();
create trigger ab_md_active_instrument_use before insert on plant.instrument_use for each row execute function md.require_active_row();
create trigger ab_md_active_erp_material before insert on site.erp_material for each row execute function md.require_active_row();
create trigger ab_md_active_material_lot before insert on site.material_lot for each row execute function md.require_active_row();

-- An entry that names a received material lot (in any member, any block): the lot's material is active at the write.
create function md.require_active_entry() returns trigger
language plpgsql security definer set search_path = pg_catalog, md, site, iam, pg_temp as $$
declare
  v_material text;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' or not iam.platform_build() then
    return new;
  end if;
  for v_material in
    select distinct l.material_code
      from jsonb_path_query(coalesce(new.command -> 'entry', 'null'::jsonb), 'strict $.**') as s (v)
      join site.material_lot l on l.lot_code = s.v #>> '{}'
     where jsonb_typeof(s.v) = 'string' and l.material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING')
     order by 1
  loop
    perform md.require_active('material', v_material);
  end loop;
  return new;
end
$$;
create trigger ab_md_active_entry before insert on recipe.execution_command for each row execute function md.require_active_entry();

-- The batch issue: as 1218 with the product's write-time check added (one line).
create or replace function recipe.require_issue_permission(p_product text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_perms text[];
  v_held  text[];
  v_perm  text;
begin
  select permissions into v_perms from recipe.execution_command_permission where command_type = 'ISSUE';
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = 'ISSUE is not available on test runs in this release; it arrives with the next increment (DI-34). [EBMR-EXE-003]';
  end if;
  v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
  select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
  v_perm := coalesce(v_perm, v_perms[1]);
  -- Phase B slice 3 (PL-08): the product is active in master data at the issue.
  if nullif(btrim(p_product), '') is not null then
    perform md.require_active('product', p_product);
  end if;
  return iam.require_permission(v_perm, iam.actor_location_scope()
                                        || coalesce(jsonb_strip_nulls(jsonb_build_object('product', nullif(btrim(p_product), ''))), '{}'::jsonb));
end
$$;

revoke all on function md.record_fact(text, text, text, text, text, text, boolean), md.require_active(text, text),
  md.require_active_row(), md.require_active_entry() from public;
grant execute on function md.record_fact(text, text, text, text, text, text, boolean) to ebmr_app;
grant select on md.item_map to ebmr_app;

reset role;
