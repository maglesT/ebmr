-- Tablets server, module C3 on the GMP installation (Phase 3 slice 2b item 3; docs/build-plan/phase-3/slice-2b-plan.md):
-- the lot a batch dispenses or charges, and the material check of a lot, for GMP batches as for sandbox test runs
-- (controls DI-05, PR-18, IN-23, IN-24; invariant INV-18).
--
-- Until now the execution feature ran only in the sandbox: a lot was a TEST- lot of tab.sandbox_lot (0200), the database
-- compared an entry's lot with that register only in a sandbox (tab.entry_identifier_problem, 0370), and the material
-- check read the MBR of a batch from its test package (tab.entry_lot_material_problem, 0600). A GMP batch (recipe-core
-- 0500) runs the control recipe of an effective MBR version and has no test package, so:
--   * tab.lot_facts(p_code, p_batch): the lot as the server hands it to the block at the moment of use, from the
--     register of this installation: tab.sandbox_lot in a sandbox (unchanged), site.material_lot in a GMP database (site
--     services 0710 to 0721), the lot of that code at the batch's site (the planned batch's site; without a batch, the
--     only site holding that code). On GMP the status the block reads is RELEASED only while the lot's state is a usable
--     one (site.usable_lot_states: RELEASED, RELEASED_FOR_FURTHER_PROCESSING); a lot in quarantine, on hold, recalled,
--     rejected or returned keeps that status, and a consumed or destroyed lot reads as REJECTED (never usable). Expiry and
--     retest are the register's instants (the block compares them with the database time of the command, PR-18), and
--     identityTested is whether the identity rule of the batch's markets holds for the lot now
--     (site.identity_rule_problem, IN-24 (c)); without a batch, whether a passing identity result and no failing one is
--     recorded. NULL when the register holds no such lot.
--   * tab.resolve_lot(p_code) (0200, read by the server's lot route) and the new tab.resolve_lot(p_code, p_batch) (read
--     by the server inside a command) answer from tab.lot_facts.
--   * tab.entry_identifier_problem(p_batch, p_entry): 0370's checks of the identifiers an entry records (TEST- ones in a
--     sandbox, real ones in GMP: sandbox.identifier_problem, unchanged) and, in either installation now, that an entry's
--     lot states exactly the facts the register gives for it now (in GMP a lot the register does not hold is refused, as
--     in the sandbox). tab.entry_identifiers_check (the trigger of 0370) calls it with the row's batch; 0370's
--     one-argument function is kept for any other caller and still checks the sandbox register only.
--   * tab.entry_lot_material_problem(p_batch, p_entry): 0600's function with the MBR read through
--     recipe.execution_mbr_content(package_hash, control_recipe_id) (recipe-core 0500): the test package's content for
--     a test run, the control recipe's content for a GMP batch. Nothing else of it changes.
-- Messages are those of 0370 and 0600 (EBMR-EXE-078). CREATE OR REPLACE keeps owners, grants and triggers. Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- PR-18, IN-24 (c), DI-05: the lot p_code as the block takes it, from this installation's register (see above).
create function tab.lot_facts(p_code text, p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, platform, kernel, pg_temp as $$
declare
  v_site    text;
  v_markets text[];
  v_id      uuid;
  v_state   text;
  v_tested  boolean;
  l         record;
begin
  if p_code is null then
    return null;
  end if;
  if kernel.installation_kind() = 'SANDBOX' then
    return (select jsonb_build_object(
                     'lotCode', s.lot_code, 'materialCode', s.material_code, 'materialName', s.material_name, 'status', s.status,
                     'expiresAtUs', case when s.expires_at is null then null else platform.epoch_micros(s.expires_at)::text end,
                     'retestAtUs', case when s.retest_at is null then null else platform.epoch_micros(s.retest_at)::text end,
                     'identityTested', s.identity_tested)
              from tab.sandbox_lot s where s.lot_code = p_code);
  end if;
  if p_batch is not null then
    select b.site, b.markets into v_site, v_markets from recipe.stub_batch b where b.id = p_batch;
  end if;
  if v_site is not null then
    select m.id into v_id from site.material_lot m where m.site_code = v_site and m.lot_code = p_code;
  elsif (select count(*) from site.material_lot m where m.lot_code = p_code) = 1 then
    select m.id into v_id from site.material_lot m where m.lot_code = p_code;
  end if;
  if v_id is null then
    return null;
  end if;
  select * into l from site.material_lot m where m.id = v_id;
  v_state := site.lot_state(v_id);
  if v_markets is not null then
    v_tested := (select x.p_problem is null from site.identity_rule_problem((select m from site.material_lot m where m.id = v_id), v_markets) x);
  else
    v_tested := exists (select 1 from site.lot_identity_result r where r.lot_id = v_id and r.result = 'PASS')
                and not exists (select 1 from site.lot_identity_result r where r.lot_id = v_id and r.result = 'FAIL');
  end if;
  return jsonb_build_object(
    'lotCode', l.lot_code, 'materialCode', l.material_code, 'materialName', l.material_name,
    'status', case when v_state = any (site.usable_lot_states()) then 'RELEASED'
                   when v_state in ('QUARANTINE', 'ON_HOLD', 'RECALLED', 'REJECTED', 'RETURNED') then v_state
                   else 'REJECTED' end,
    'expiresAtUs', platform.epoch_micros(l.expires_at)::text,
    'retestAtUs', case when l.retest_at is null then null else platform.epoch_micros(l.retest_at)::text end,
    'identityTested', coalesce(v_tested, false));
end
$$;

-- The lot as the server knows it now (0200's reader, from tab.lot_facts).
create or replace function tab.resolve_lot(p_code text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select tab.lot_facts(p_code, null)
$$;

-- The lot as batch p_batch uses it now (the server's read inside a command).
create function tab.resolve_lot(p_code text, p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select tab.lot_facts(p_code, p_batch)
$$;

-- DI-05, PR-18: 0370's tab.entry_identifier_problem for an entry of batch p_batch, with the lot compared with this
-- installation's register in GMP too.
create function tab.entry_identifier_problem(p_batch uuid, p_entry jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, platform, sandbox, kernel, pg_temp as $$
declare
  v_kind  text := p_entry ->> 'kind';
  v_check record;
  v_p     text;
  v_lot   jsonb;
  v_reg   jsonb;
  v_facts jsonb;
begin
  for v_check in
    select c.member, c.idkind
      from (values ('PREVIOUS_BATCH', 'batchNumber', 'BATCH_NUMBER'), ('CHARGE_CONTAINER', 'scannedBatch', 'BATCH_NUMBER'),
                   ('SOURCE_ADDITION', 'sourceBatch', 'BATCH_NUMBER'),
                   ('CONTAINER_WEIGHING', 'container', 'LOT_NUMBER'), ('CHARGE_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('CHARGE_LOT', 'container', 'LOT_NUMBER'), ('OUTPUT_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('SAMPLE', 'container', 'LOT_NUMBER'), ('DISPOSAL', 'container', 'LOT_NUMBER')) c (kind, member, idkind)
     where c.kind = v_kind and p_entry ? c.member and jsonb_typeof(p_entry -> c.member) is distinct from 'null'
  loop
    continue when v_kind = 'PREVIOUS_BATCH' and p_entry -> v_check.member = '"NONE"'::jsonb;
    v_p := sandbox.identifier_problem(v_check.idkind, p_entry ->> v_check.member);
    if v_p is not null then
      return format('%s %s', v_check.member, regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
  end loop;
  if v_kind in ('CONTAINER_WEIGHING', 'CHARGE_LOT') then
    v_lot := p_entry -> 'lot';
    v_p := sandbox.identifier_problem('LOT_NUMBER', coalesce(v_lot ->> 'id', ''));
    if v_p is not null then
      return format('lot %s', regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
    v_facts := tab.lot_facts(v_lot ->> 'id', p_batch);
    if v_facts is null then
      return format('lot %s is not a registered %slot of this installation', left(v_lot ->> 'id', 64),
                    case when kernel.installation_kind() = 'SANDBOX' then 'test ' else 'material ' end);
    end if;
    v_reg := jsonb_strip_nulls(jsonb_build_object(
               'id', v_facts -> 'lotCode', 'material', v_facts -> 'materialCode', 'status', v_facts -> 'status',
               'expiresAtUs', v_facts -> 'expiresAtUs', 'retestAtUs', v_facts -> 'retestAtUs', 'identityTested', v_facts -> 'identityTested'));
    if v_lot is distinct from v_reg then
      return format('lot %s states other facts than the lot register holds (%s)', v_lot ->> 'id', v_reg::text);
    end if;
  end if;
  return null;
end
$$;

create or replace function tab.entry_identifiers_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' then
    return new;
  end if;
  v_problem := tab.entry_identifier_problem(new.batch_id, new.command -> 'entry');
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s entry of this RECORD_ENTRY row is refused: %s; an entry records only the identifiers of this installation and registered lots (DI-05, PR-18). [EBMR-EXE-078]',
                       coalesce(new.command -> 'entry' ->> 'kind', 'unnamed'), v_problem);
  end if;
  return new;
end
$$;

-- DI-05, PR-18: 0600's check, with the MBR of the batch from its test package or its control recipe.
create or replace function tab.entry_lot_material_problem(p_batch uuid, p_entry jsonb) returns text
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_mbr  jsonb;
  v_mat  text;
  v_bom  jsonb;
  v_refs jsonb;
begin
  if jsonb_typeof(p_entry) is distinct from 'object' or p_entry ->> 'kind' is distinct from 'CONTAINER_WEIGHING' and p_entry ->> 'kind' is distinct from 'CHARGE_LOT'
     or jsonb_typeof(p_entry -> 'lot') is distinct from 'object' then
    return null;
  end if;
  select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) into v_mbr
    from recipe.batch_execution b
   where b.id = p_batch;
  v_mat := case when jsonb_typeof(p_entry -> 'lot' -> 'material') = 'string' then p_entry -> 'lot' ->> 'material' end;
  v_bom := case when jsonb_typeof(v_mbr -> 'bom') = 'array' then v_mbr -> 'bom' else '[]'::jsonb end;
  v_refs := case when jsonb_typeof(v_mbr -> 'references') = 'array' then v_mbr -> 'references' else '[]'::jsonb end;
  if v_mat is not null and exists (
       select 1 from jsonb_array_elements(v_bom) l
        where l ->> 'material' = v_mat
           or exists (select 1 from jsonb_array_elements(v_refs) r where r ->> 'id' = l ->> 'material' and r ->> 'code' = v_mat)) then
    return null;
  end if;
  return format('lot %s is of material %s, which the MBR of this batch does not name (its bill of materials names %s)',
                left(coalesce(p_entry -> 'lot' ->> 'id', 'without an id'), 64), left(coalesce(v_mat, 'none'), 64),
                coalesce((select string_agg(distinct l ->> 'material', ', ' order by l ->> 'material') from jsonb_array_elements(v_bom) l), 'no material'));
end
$$;

revoke all on function tab.lot_facts(text, uuid), tab.resolve_lot(text, uuid), tab.entry_identifier_problem(uuid, jsonb) from public;
grant execute on function tab.resolve_lot(text, uuid) to ebmr_app;

reset role;
