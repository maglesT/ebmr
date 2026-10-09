-- Tablets server, modules C3 and C5: a scale reading is claimed only as the tare or the gross of a weighing, and a lot a
-- test run names is of a material the batch's MBR names (Phase 2 exit review F12, the lane's round-2 verification;
-- controls DI-05, DI-32, PR-18; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
-- What was wrong. Decision F12.6 listed two texts the application role can write and no identifier rule reads as
-- "reported, not decided here"; the verification found that neither needs the owner:
--   * tab.reading_use.purpose (tablets 0250, 0360 tab.claim_readings): any text that is not blank. The server claims a
--     reading only as TARE or GROSS (features/execution intents.ts), but a claim through the application role recorded
--     any purpose, the real-format lot number L2409-0017 included, in the reading's use row and its audit entry;
--   * tab.sandbox_lot.material_code (tablets 0200): any code of the form ^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$, which
--     L2409-0017 has. tablets 0370 binds the lot an entry names to the register (its material included), so a weighing
--     of a test lot registered with the material L2409-0017 recorded that text in the row's entry and evidence: the
--     engine refuses such a lot as the wrong material (G07-WRONG-MATERIAL), and the refused row keeps it.
--
-- What changed (defaults of 3 October, decision F12.7):
--   * trigger aa_tab_reading_use_purpose (before insert on tab.reading_use; EBMR-DEV-106, the code of a claim's purpose):
--     a reading is claimed as TARE or GROSS only, the purposes the server claims. A reading the gateway took for CHECK
--     cannot be claimed (no flow of this release uses one); a later release that claims CHECK adds it with its flow;
--   * trigger ad_tab_entry_lot_material (before insert on recipe.execution_command, after ad_tab_entry_identifiers of
--     0370; EBMR-EXE-078, the code of 0370): a RECORD_ENTRY row, accepted or refused, whose CONTAINER_WEIGHING or
--     CHARGE_LOT entry names a lot of a material the batch's MBR does not name (a material of its bill of materials, or
--     the code of the MBR's reference that a bill-of-materials line names, as the engine compares them, blocks
--     material.ts lotProblems) is refused. The engine's refusal of a lot of another material of the same MBR (a
--     cellulose lot at the paracetamol weighing) stays recordable; a lot of a material the MBR does not have at all is
--     refused before it is recorded, as 0370 refuses a lot that is not in the register.
-- What this does not decide (decision F12.7): the register itself (tab.sandbox_lot) may still hold such a material code,
-- and a lot's material name is text the register keeps for the screen and no row records. Holding the register to the
-- materials of an imported test package would make the sandbox's set-up order a rule (lots are registered by the set-up
-- seed before any package is imported); that is left to the owner. An imported package's own material codes stay with
-- the open item on the package (F12.5).
--
-- Privileges: the trigger functions are SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016), and nobody
-- executes them directly. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-32: a scale reading is claimed as the tare or the gross of a weighing (header).
create function tab.reading_use_purpose_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if new.purpose is null or new.purpose not in ('TARE', 'GROSS') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-106 DI-32: reading %s cannot be claimed as "%s": a scale reading is claimed only as the TARE or the GROSS of a weighing, the purposes the server claims (DI-05)',
                       new.reading_id, left(coalesce(new.purpose, 'nothing'), 64));
  end if;
  return new;
end
$$;

create trigger aa_tab_reading_use_purpose before insert on tab.reading_use
  for each row execute function tab.reading_use_purpose_check();

-- DI-05, PR-18: why entry p_entry of a row of test batch p_batch names a lot of a material the batch's MBR does not name;
-- NULL when it names no lot or one of such a material.
create function tab.entry_lot_material_problem(p_batch uuid, p_entry jsonb) returns text
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
  select pk.content into v_mbr
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash
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

create function tab.entry_lot_material_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' then
    return new;
  end if;
  v_problem := tab.entry_lot_material_problem(new.batch_id, new.command -> 'entry');
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s entry of this RECORD_ENTRY row is refused: %s; a lot a test run names is of a material its MBR names (DI-05, PR-18). [EBMR-EXE-078]',
                       coalesce(new.command -> 'entry' ->> 'kind', 'unnamed'), v_problem);
  end if;
  return new;
end
$$;

create trigger ad_tab_entry_lot_material before insert on recipe.execution_command
  for each row execute function tab.entry_lot_material_check();

revoke all on function tab.reading_use_purpose_check(), tab.entry_lot_material_problem(uuid, jsonb), tab.entry_lot_material_check() from public;

reset role;
