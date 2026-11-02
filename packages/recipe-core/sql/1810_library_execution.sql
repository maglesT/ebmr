-- Recipe core, decision 0026 slice S4: library blocks in masters and batches.
--
-- Handbook: modules/recipe-core.md
--
-- A master carries snapshots of the library definitions it uses (content -> 'blockDefinitions'); a phase names one as
-- block {type: 'LIB-<code>', version}. The engine builds the block version from that snapshot (recipe-core
-- library/integration.ts). The database holds the regulation-required core (decision 0008 section 2; owner decision O-9
-- (b): calculated figures are the server's, stored with their evaluation record, and never recomputed here):
--
--   recipe.library_definition(content, block)        the snapshot a phase's LIB block names, or NULL.
--   recipe.library_entry_schema(content, block, kind) the data schema of a library entry kind (a section id, or
--                                                     TIMER_START / TIMER_STOP), in recipe.block_data_schema's form,
--                                                     derived from the snapshot as library/block-version.ts derives it:
--                                                     a calculated field is not in it, so a typed one is refused (INV-25).
--   recipe.entry_schema_of(content, block, part, kind)  block_data_schema_of, or the library schema for a LIB block.
--   recipe.entry_schema_problem                       CREATE OR REPLACE from its latest definition (0332), reading
--                                                     schemas through entry_schema_of; nothing else changes.
--   recipe.library_limits_problem(content, old, new)  every library entry a row adds: each number, weighing,
--                                                     calculated value or timer duration with a limit in the phase's
--                                                     configuration is read against that limit (recipe.limit_reading);
--                                                     a breach needs LIB_LIMIT_BREACH for that step and item,
--                                                     raised in the same row (PR-08). A loop's exit value is the loop's to
--                                                     judge, as in the engine. Trigger zzg_library_limits, EBMR-LIB-020.
--   recipe.library_snapshot_problem(content, current) every snapshot is an approved library version with the same
--                                                     content hash (and, when current, not retired); every LIB phase
--                                                     names a snapshot, and a hash pinned in its configuration is the
--                                                     snapshot's. Checked when a master version is approved (EBMR-LIB-021,
--                                                     current) and when a GMP batch's control recipe is recorded
--                                                     (EBMR-LIB-022: a retired version keeps serving masters approved on it).
-- A library limit is written in its field's unit (library/check-use: LIB-USE-LIMIT-UNIT), so the database compares in
-- one unit, as recipe.limit_value does. Messages EBMR-LIB-020 to EBMR-LIB-029.

set local role ebmr_owner;

create function recipe.library_definition(p_content jsonb, p_block jsonb) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select d from jsonb_array_elements(case when jsonb_typeof(p_content -> 'blockDefinitions') = 'array' then p_content -> 'blockDefinitions' else '[]'::jsonb end) d
   where 'LIB-' || (d ->> 'code') = p_block ->> 'type' and (d ->> 'version') = p_block ->> 'version'
   limit 1
$$;

-- One field's schema, as library/block-version.ts fieldSchema writes it; NULL for a field that is never typed.
create function recipe.library_field_schema(f jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case f ->> 'type'
           when 'NUMBER' then '{"type": "decimal", "optional": true}'::jsonb
           when 'WEIGHING' then '{"type": "decimal", "optional": true}'::jsonb
           when 'TEXT' then case when f ? 'pattern' then jsonb_build_object('type', 'string', 'optional', true, 'pattern', '^(?:' || (f ->> 'pattern') || ')$')
                                 else '{"type": "string", "optional": true}'::jsonb end
           when 'YES_NO' then '{"type": "boolean", "optional": true}'::jsonb
           when 'CHOICE' then jsonb_build_object('type', 'string', 'optional', true, 'enum', f -> 'options')
           when 'DATE_TIME' then '{"type": "string", "optional": true, "pattern": "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2})?)?$"}'::jsonb
           when 'MATERIAL_LOT' then '{"type": "string", "optional": true}'::jsonb
           when 'EQUIPMENT' then '{"type": "string", "optional": true}'::jsonb
           when 'CONTAINER' then '{"type": "string", "optional": true}'::jsonb
           when 'SAMPLE' then '{"type": "integer", "optional": true, "min": 1, "max": 100000}'::jsonb
           when 'TEST_RESULT' then case when (f -> 'perPoint') = 'true'::jsonb
                                        then '{"type": "record", "optional": true, "values": {"type": "array", "minItems": 1, "maxItems": 1000, "items": {"type": "decimal"}}}'::jsonb
                                        else '{"type": "array", "optional": true, "minItems": 1, "maxItems": 1000, "items": {"type": "decimal"}}'::jsonb end
           else null
         end
$$;

create function recipe.library_entry_schema(p_content jsonb, p_block jsonb, p_kind text) returns jsonb
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
  return jsonb_build_object('type', 'object', 'fields', v_fields);
end
$$;

create function recipe.entry_schema_of(p_content jsonb, p_block jsonb, p_part text, p_kind text) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when coalesce(p_block ->> 'type', '') like 'LIB-%'
              then case when p_part = 'ENTRY' then recipe.library_entry_schema(p_content, p_block, p_kind) end
              else recipe.block_data_schema_of(p_block, p_part, p_kind) end
$$;

-- CREATE OR REPLACE from its latest definition (recipe-core 0332): schemas are read through entry_schema_of, and a refused
-- entry of a library block is held to its own snapshot's schema.
create or replace function recipe.entry_schema_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb, p_accepted boolean) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_type    text := p_command ->> 'type';
  v_step    text;
  v_block   jsonb;
  v_name    text;
  v_kind    text;
  v_entry   jsonb;
  v_schema  jsonb;
  v_problem text;
  k         text;
  e         jsonb;
  d         jsonb;
  f         text;
begin
  -- A refused row keeps what was sent, which the engine refused (its schema included), but never a member that no block
  -- version declares for that kind of entry or for start data.
  if p_accepted is not true and v_type = 'RECORD_ENTRY' then
    v_entry := p_command -> 'entry';
    if jsonb_typeof(v_entry) is distinct from 'object' or jsonb_typeof(v_entry -> 'kind') is distinct from 'string' then
      return format('records at step %s a refused entry that names no kind (ENG-ENTRY-KIND)', coalesce(p_command ->> 'step', '(none)'));
    end if;
    v_kind := v_entry ->> 'kind';
    v_entry := v_entry - 'kind';
  elsif p_accepted is not true and v_type = 'START_STEP' and p_command ? 'blockData' then
    v_kind := 'START_DATA';
    v_entry := p_command -> 'blockData';
  end if;
  -- Decision 0026 (S4): a refused entry of a library block is held to the schema of that block's own snapshot.
  if p_accepted is not true and v_kind is not null and (recipe.step_node(p_content, p_command ->> 'step') -> 'block' ->> 'type') like 'LIB-%' then
    v_schema := recipe.entry_schema_of(p_content, recipe.step_node(p_content, p_command ->> 'step') -> 'block', case when v_type = 'START_STEP' then 'START' else 'ENTRY' end, v_kind);
    if v_schema is null then
      return format('records at step %s a refused entry of kind %s, which its library block does not record (ENG-ENTRY-KIND)', coalesce(p_command ->> 'step', '(none)'), v_kind);
    end if;
    v_problem := recipe.block_schema_unknown_member(v_schema, v_entry, v_kind);
    if v_problem is not null then
      return format('records at step %s a refused entry holding a member its library block does not declare: %s (ENG-ENTRY-SCHEMA)', coalesce(p_command ->> 'step', '(none)'), v_problem);
    end if;
    v_kind := null;
  end if;
  if p_accepted is not true and v_kind is not null then
    v_problem := null;
    for v_schema in select s.schema from recipe.block_data_schema s
                     where s.part = case when v_type = 'START_STEP' then 'START' else 'ENTRY' end and s.entry_kind = v_kind
                     order by s.block_type, s.block_version loop
      v_problem := recipe.block_schema_unknown_member(v_schema, v_entry, case when v_type = 'START_STEP' then 'startData' else v_kind end);
      exit when v_problem is null;
    end loop;
    if not found then
      return format('records at step %s %s, which no block version records (ENG-ENTRY-KIND)', coalesce(p_command ->> 'step', '(none)'),
                    case when v_type = 'START_STEP' then 'refused start data' else 'a refused entry of kind ' || v_kind end);
    end if;
    if v_problem is not null then
      return format('records at step %s %s holding a member no block version declares for it: %s (ENG-ENTRY-SCHEMA)', coalesce(p_command ->> 'step', '(none)'),
                    case when v_type = 'START_STEP' then 'refused start data' else 'a refused entry' end, v_problem);
    end if;
  end if;
  -- An accepted command's own entry or start data, as the engine checks it before the block sees it (steps.ts
  -- recordEntry, startStep).
  if p_accepted is true and v_type in ('RECORD_ENTRY', 'START_STEP') then
    v_step := p_command ->> 'step';
    v_block := recipe.step_node(p_content, v_step) -> 'block';
    v_name := coalesce(v_block ->> 'type', '(no block)') || '@' || coalesce(v_block ->> 'version', '?');
    if v_type = 'RECORD_ENTRY' then
      v_entry := p_command -> 'entry';
      if jsonb_typeof(v_entry) is distinct from 'object' or jsonb_typeof(v_entry -> 'kind') is distinct from 'string' then
        return format('records at step %s an entry that names no kind (ENG-ENTRY-KIND)', coalesce(v_step, '(none)'));
      end if;
      v_kind := v_entry ->> 'kind';
      v_schema := recipe.entry_schema_of(p_content, v_block, 'ENTRY', v_kind);
      if v_schema is null then
        return format('records an entry of kind %s at step %s, whose block %s does not record that kind (ENG-ENTRY-KIND)', v_kind, coalesce(v_step, '(none)'), v_name);
      end if;
      v_problem := recipe.block_schema_problem(v_schema, v_entry - 'kind', v_kind);
      if v_problem is not null then
        return format('records at step %s an entry that does not meet the data schema of block %s: %s (ENG-ENTRY-SCHEMA)', v_step, v_name, v_problem);
      end if;
    elsif p_command ? 'blockData' then
      v_schema := recipe.entry_schema_of(p_content, v_block, 'START', 'START_DATA');
      if v_schema is null then
        return format('starts step %s with start data, and its block %s takes none (ENG-ENTRY-SCHEMA)', coalesce(v_step, '(none)'), v_name);
      end if;
      v_problem := recipe.block_schema_problem(v_schema, p_command -> 'blockData', 'startData');
      if v_problem is not null then
        return format('starts step %s with start data that does not meet the start-data schema of block %s: %s (ENG-ENTRY-SCHEMA)', v_step, v_name, v_problem);
      end if;
    end if;
  end if;
  -- Every entry the row adds: of a kind its step's block records, its data meeting that kind's schema.
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by x.key loop
    v_kind := e ->> 'kind';
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_block := recipe.step_node(p_content, v_step) -> 'block';
    v_name := coalesce(v_block ->> 'type', '(no block)') || '@' || coalesce(v_block ->> 'version', '?');
    v_schema := recipe.entry_schema_of(p_content, v_block, case when v_kind = 'START_DATA' then 'START' else 'ENTRY' end, v_kind);
    if v_schema is null then
      return format('stores entry %s (%s) of step %s, a kind its block %s does not record (ENG-ENTRY-KIND)', k, coalesce(v_kind, 'unnamed'), coalesce(e ->> 'stepKey', '(none)'), v_name);
    end if;
    d := e -> 'data';
    if v_kind = 'START_DATA' then
      v_problem := recipe.block_schema_problem(v_schema, d, 'startData');
    elsif jsonb_typeof(d) is distinct from 'object' then
      v_problem := v_kind || ' must be an object';
    else
      v_problem := null;
      for f in select x from jsonb_object_keys(v_schema -> 'fields') x where d ? x order by x loop
        v_problem := recipe.block_schema_problem(v_schema -> 'fields' -> f, d -> f, v_kind || '.' || f);
        exit when v_problem is not null;
      end loop;
    end if;
    if v_problem is not null then
      return format('stores entry %s (%s) of step %s whose data does not meet the data schema of block %s: %s (ENG-ENTRY-SCHEMA)', k, v_kind, e ->> 'stepKey', v_name, v_problem);
    end if;
  end loop;
  return null;
end
$$;

-- PR-08 (header): library values against the formulation's limits; the engine's exception must be there.
create function recipe.library_limits_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1       jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  x0       jsonb := case when jsonb_typeof(p_old -> 'exceptions') = 'object' then p_old -> 'exceptions' else '{}'::jsonb end;
  x1       jsonb := case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  v_step   text;
  v_node   jsonb;
  d        jsonb;
  s        jsonb;
  f        jsonb;
  v_val    text;
  v_unit   text;
  v_spec   jsonb;
  v_ev     jsonb;
  v_until  text;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by x.key loop
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    if coalesce(v_node -> 'block' ->> 'type', '') not like 'LIB-%' then
      continue;
    end if;
    d := recipe.library_definition(p_content, v_node -> 'block');
    if d is null then
      return format('stores entry %s of step %s, whose library block %s@%s is not in the master''s snapshots', k, v_step, v_node -> 'block' ->> 'type', v_node -> 'block' ->> 'version');
    end if;
    if e ->> 'kind' = 'TIMER_STOP' then
      select x into f from jsonb_array_elements(d -> 'sections') sec, jsonb_array_elements(sec -> 'fields') x where x ->> 'id' = e -> 'data' ->> 'field' limit 1;
      v_val := e -> 'data' -> 'duration' ->> 'value';
      v_unit := coalesce(f ->> 'durationUnit', 'min');
      v_spec := case when f ? 'limitSlot' then v_node -> 'config' -> 'limits' -> (f ->> 'limitSlot') end;
      if v_spec is not null then
        if v_val is null or (v_spec ->> 'unit') is distinct from v_unit then
          return format('stores the stop of timer %s at step %s without a duration the database can read against its limit', f ->> 'id', v_step);
        end if;
        v_ev := recipe.limit_reading(v_spec, v_val);
        if v_ev is null then
          return format('stores the duration %s of timer %s at step %s, which the database cannot read against its limit', v_val, f ->> 'id', v_step);
        end if;
        if v_ev ->> 'breached' is not null and not exists (
             select 1 from jsonb_each(x1) y where not (x0 ? y.key) and y.value ->> 'type' = 'LIB_LIMIT_BREACH'
                and y.value -> 'source' ->> 'stepKey' = e ->> 'stepKey' and y.value -> 'source' ->> 'item' = v_step || '.' || (f ->> 'id')) then
          return format('stores timer %s at step %s with %s %s, outside its %s limit, without the LIB_LIMIT_BREACH it requires', f ->> 'id', v_step, v_val, v_unit, lower(v_ev ->> 'breached'));
        end if;
      end if;
      continue;
    end if;
    select x into s from jsonb_array_elements(d -> 'sections') x where x ->> 'id' = e ->> 'kind' limit 1;
    if s is null then
      continue;
    end if;
    v_until := case when s -> 'repeat' ->> 'kind' = 'UNTIL_PASS' then s -> 'repeat' ->> 'untilField' end;
    for f in select x from jsonb_array_elements(s -> 'fields') x
              where x ->> 'type' in ('NUMBER', 'WEIGHING', 'CALC') and x ? 'limitSlot' and (x ->> 'id') is distinct from v_until loop
      v_spec := v_node -> 'config' -> 'limits' -> (f ->> 'limitSlot');
      v_val := case when f ->> 'type' = 'CALC' then e -> 'data' -> 'computed' -> (f ->> 'id') ->> 'value' else e -> 'data' ->> (f ->> 'id') end;
      if v_spec is null or v_val is null then
        continue;
      end if;
      if (v_spec ->> 'unit') is distinct from (f ->> 'unit') then
        return format('stores %s at step %s, whose limit is not written in the field''s unit %s', f ->> 'id', v_step, f ->> 'unit');
      end if;
      v_ev := recipe.limit_reading(v_spec, v_val);
      if v_ev is null then
        return format('stores %s = %s at step %s, which the database cannot read against its limit', f ->> 'id', v_val, v_step);
      end if;
      if v_ev ->> 'breached' is not null and not exists (
           select 1 from jsonb_each(x1) y where not (x0 ? y.key) and y.value ->> 'type' = 'LIB_LIMIT_BREACH'
              and y.value -> 'source' ->> 'stepKey' = e ->> 'stepKey' and y.value -> 'source' ->> 'item' = v_step || '.' || (f ->> 'id')) then
        return format('stores %s = %s %s at step %s, outside its %s limit, without the LIB_LIMIT_BREACH it requires', f ->> 'id', v_val, f ->> 'unit', v_step, lower(v_ev ->> 'breached'));
      end if;
    end loop;
  end loop;
  return null;
end
$$;

create function recipe.library_limits_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false)) then
    return null;
  end if;
  v_problem := recipe.library_limits_problem(recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This row %s: a library value outside the formulation''s limit carries its LIB_LIMIT_BREACH (PR-08; decision 0026). [EBMR-LIB-020]', v_problem);
  end if;
  return null;
end
$$;

create trigger zzg_library_limits after update on recipe.execution_state for each row execute function recipe.library_limits_check();

-- The snapshots against the library (header); NULL when they agree.
create function recipe.library_snapshot_problem(p_content jsonb, p_current boolean) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  d      jsonb;
  b      recipe.library_block;
  p      jsonb;
begin
  for d in select x from jsonb_array_elements(case when jsonb_typeof(p_content -> 'blockDefinitions') = 'array' then p_content -> 'blockDefinitions' else '[]'::jsonb end) x loop
    select * into b from recipe.library_block l where l.code = d ->> 'code' and l.version::text = d ->> 'version';
    if b.id is null then
      return format('%s@%s is not in the library', d ->> 'code', d ->> 'version');
    end if;
    if b.content_hash is distinct from recipe.json_hash(d) then
      return format('the snapshot of %s@%s differs from the library version (content hash)', b.code, b.version);
    end if;
    if recipe.library_block_state(b.id) = 'DRAFT' then
      return format('%s@%s is not approved', b.code, b.version);
    end if;
    if p_current and recipe.library_block_state(b.id) = 'RETIRED' then
      return format('%s@%s is retired; use a current version', b.code, b.version);
    end if;
  end loop;
  for p in select x from jsonb_path_query(p_content, 'lax $.procedure.** ? (@.kind == "phase")') x where coalesce(x -> 'block' ->> 'type', '') like 'LIB-%' loop
    d := recipe.library_definition(p_content, p -> 'block');
    if d is null then
      return format('step %s uses %s@%s, which the master carries no snapshot of', p ->> 'id', p -> 'block' ->> 'type', p -> 'block' ->> 'version');
    end if;
    if p -> 'config' ? 'hash' and (p -> 'config' ->> 'hash') is distinct from recipe.json_hash(d) then
      return format('step %s pinned a content hash that is not its snapshot''s', p ->> 'id');
    end if;
  end loop;
  return null;
end
$$;

create function recipe.library_at_approval_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_prob text;
begin
  if new.aggregate_type = 'mbr_version' and new.event = 'APPROVE' then
    v_prob := recipe.library_snapshot_problem((recipe.current_content(new.aggregate_id)).content, true);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-LIB-021 this master cannot be approved: %s (PR-05; decision 0026)', v_prob);
    end if;
  end if;
  return new;
end
$$;

create trigger a4_library_at_approval before insert on platform.state_history for each row execute function recipe.library_at_approval_check();

create function recipe.library_at_issue_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_prob text := recipe.library_snapshot_problem(new.snapshot -> 'mbr' -> 'content', false);
begin
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-LIB-022 this batch cannot be issued: %s (PR-05; decision 0026)', v_prob);
  end if;
  return new;
end
$$;

create trigger a4_library_at_issue before insert on recipe.control_recipe for each row execute function recipe.library_at_issue_check();

revoke all on function recipe.library_definition(jsonb, jsonb), recipe.library_field_schema(jsonb), recipe.library_entry_schema(jsonb, jsonb, text),
                       recipe.entry_schema_of(jsonb, jsonb, text, text), recipe.library_limits_problem(jsonb, jsonb, jsonb), recipe.library_limits_check(),
                       recipe.library_snapshot_problem(jsonb, boolean), recipe.library_at_approval_check(), recipe.library_at_issue_check() from public;

reset role;
