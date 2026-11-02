-- Recipe core, decision 0026 slice S11 finding: the server-filled facts of a library entry are part of its data schema.
--
-- Handbook: modules/recipe-core.md
--
-- Since S6 the server fills a library entry's `lots` (by MATERIAL_LOT field, read from the lot register) and
-- `equipment` (by EQUIPMENT field, read from the plant register) before the engine sees it, and tablets 1803 compares
-- them with the registers. The data schema the database holds an entry to (1810 recipe.library_entry_schema) still
-- listed only the typed fields, so a section with an equipment or lot field was refused as carrying an unknown member
-- (ENG-ENTRY-SCHEMA), found by the three-tablet acceptance run. The schema now carries both members, as
-- library/block-version.ts sectionSchema writes them (LOT_FACTS, EQUIPMENT_FACTS), and only for a section that has such
-- a field: an entry of any other section carrying them is still refused.
--
--   recipe.library_entry_schema: CREATE OR REPLACE from its latest definition (1810). Nothing else changes.

set local role ebmr_owner;

create or replace function recipe.library_entry_schema(p_content jsonb, p_block jsonb, p_kind text) returns jsonb
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  d       jsonb := recipe.library_definition(p_content, p_block);
  s       jsonb;
  v_fields jsonb := '{}'::jsonb;
  f       jsonb;
  v_timers jsonb;
begin
  if d is null then
    return null;
  end if;
  if p_kind in ('TIMER_START', 'TIMER_STOP') then
    select coalesce(jsonb_agg(x ->> 'id'), '[]'::jsonb) into v_timers
      from jsonb_array_elements(d -> 'sections') sec, jsonb_array_elements(sec -> 'fields') x where x ->> 'type' = 'TIMER';
    if jsonb_array_length(v_timers) = 0 then
      return null;
    end if;
    return jsonb_build_object('type', 'object', 'fields', jsonb_build_object('field', jsonb_build_object('type', 'string', 'enum', v_timers)));
  end if;
  select x into s from jsonb_array_elements(d -> 'sections') x where x ->> 'id' = p_kind limit 1;
  if s is null then
    return null;
  end if;
  for f in select x from jsonb_array_elements(s -> 'fields') x loop
    if recipe.library_field_schema(f) is not null then
      v_fields := v_fields || jsonb_build_object(f ->> 'id', recipe.library_field_schema(f));
    end if;
  end loop;
  -- The server-filled facts (S6), for a section with such a field only.
  if exists (select 1 from jsonb_array_elements(s -> 'fields') x where x ->> 'type' = 'MATERIAL_LOT') then
    v_fields := v_fields || jsonb_build_object('lots', '{"type": "record", "optional": true, "values": {"type": "object", "fields": {
      "id": {"type": "string"}, "material": {"type": "string"}, "status": {"type": "string"},
      "expiresAtUs": {"type": "string", "optional": true}, "retestAtUs": {"type": "string", "optional": true},
      "identityTested": {"type": "boolean"}}}}'::jsonb);
  end if;
  if exists (select 1 from jsonb_array_elements(s -> 'fields') x where x ->> 'type' = 'EQUIPMENT') then
    v_fields := v_fields || jsonb_build_object('equipment', '{"type": "record", "optional": true, "values": {"type": "object", "fields": {
      "code": {"type": "string"}, "classCode": {"type": "string"}, "fitness": {"type": "string"}}}}'::jsonb);
  end if;
  return jsonb_build_object('type', 'object', 'fields', v_fields);
end
$$;

reset role;
