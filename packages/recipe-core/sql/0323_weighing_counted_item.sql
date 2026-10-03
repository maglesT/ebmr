-- Recipe core, execution store (module C3): the quantity a weighing counts into is the one its phase records in the MBR,
-- decided by the database, not by the entry (lead TODO T2 of the Phase 2 exit, round 3; INV-25, PR-19, DI-30; ADR 0012:
-- the rules hold when the application's own database credentials are used directly).
--
-- What was wrong: 0322 checks that a block value counted from weighings is the sum of the weighings of its step and
-- item, and that a step leaving IN_PROGRESS holds one such value per item its weighings name. Which weighings count into
-- which quantity it read from each entry's own data.item, and the writer controls that member: 0313 binds only the
-- members of the command that the stored entry still holds (a block may drop one), and G-22 adds item itself (it is not
-- in the command). The round-2 verification stored, through the application role, a second dispensed container
-- (10.000 kg) whose entry had no item; the engine's honest signature then recorded a dispensed quantity of 50.000 kg
-- from the first container only, and the database answered ok. An output container stored with item null was likewise
-- left out of the produced quantity. So the claim of 0322's header, that a total leaving a container out is no longer
-- stored, held only for a container whose entry names its quantity; this migration makes it hold for every one.
--
-- The blocks decide the quantity from the MBR (blocks/generic material.ts): a G-07 container counts into the dispensed
-- quantity the command names, which must be one of the mass quantities its phase records (G07-ITEM); a G-22 output
-- container counts into the first mass quantity its phase records, or into none when the phase records none. A mass
-- quantity is a parameter the phase records (as the engine expands the step: a step inlined from a library element
-- records the MBR items its call binds) that is a DECIMAL with one reading and a mass unit (common.ts massItems). This
-- migration adds:
--  - recipe.mass_unit_class(unit): MASS for g with a metric prefix (kg, g, mg, ug ...), with an exponent of 1 and an
--    annotation allowed (kg{wet}), as the expression language reads it; OTHER for any other single unit or a unit that is
--    no text, none of which the expression language reads as a mass; UNKNOWN for a compound unit (with ".", "/" or
--    parentheses) or two annotations, which the database does not read: where it matters the check fails closed;
--  - recipe.phase_records(content, step): the MBR items phase p_step records, its library bindings applied (NULL when no
--    single phase answers or a symbol is not bound: fail closed);
--  - recipe.weighing_item_problem(entry, content): NULL unless a CONTAINER_WEIGHING is not at a G-07 step or does not
--    count into a mass quantity its phase records, or an OUTPUT_CONTAINER is not at a G-22 step or does not count into
--    the first one (null only when the phase records none the database can tell), or the entry's unit is not counted
--    into its quantity's (the same unit, or both metric mass units: the units 0322 converts);
--  - a row trigger on recipe.execution_state (zm_execution_weighing_item, after update; every row; it runs before 0322's
--    zm_execution_weighing_record) that refuses a row bringing in such an entry (EBMR-EXE-139).
-- With every weighing counting into a quantity of its phase, 0322's check of the totals covers every weighing of a step.
-- Entries stored before this migration are left as they were (a batch issued under an earlier engine is neither run nor
-- replayed by engine 1.3.0: EBMR-EXE-061).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- INV-25 (T2 round 3): how the database reads unit p_unit (a JSON value) as a mass (header): MASS, OTHER or UNKNOWN.
-- The expression language reads a single unit as a mass only when it is gram with a metric prefix and the exponent 1
-- (its catalogue holds no other mass atom: blocks/generic common.ts isMassUnit), at most 120 characters long.
create function recipe.mass_unit_class(p_unit jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
           when jsonb_typeof(p_unit) is distinct from 'string' then 'OTHER'
           when length(p_unit #>> '{}') not between 1 and 120 then 'OTHER'
           when (p_unit #>> '{}') ~ '^(Y|Z|E|P|T|G|M|k|h|da|d|c|m|u|n|p|f|a|z|y)?g(\+?0*1)?(\{[!-z|~]*\})?$' then 'MASS'
           when (p_unit #>> '{}') ~ '^([^./(){}]+(\{[^{}]*\})?|\{[^{}]*\})$' then 'OTHER'
           else 'UNKNOWN'
         end
$$;

-- INV-25, PR-19 (T2 round 3): the MBR items phase p_step of MBR content p_content records, in order, as the engine
-- expands it (flow/expand.ts): a step inlined from a library element has the id <call>/<inner id> and records the items
-- its call binds to the element's symbols, through every call level. NULL when no single phase answers (recipe.step_node,
-- 0270) or a symbol is not bound (an MBR the engine refuses; fail closed).
create function recipe.phase_records(p_content jsonb, p_step text) returns text[]
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_parts text[] := string_to_array(p_step, '/');
  v_scope jsonb := p_content -> 'procedure';
  v_els   jsonb := case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end;
  v_env   jsonb;
  v_next  jsonb;
  v_node  jsonb;
  v_el    jsonb;
  v_n     bigint;
  v_out   text[] := '{}';
  s       jsonb;
begin
  if coalesce(array_length(v_parts, 1), 0) = 0 or jsonb_typeof(v_scope) is distinct from 'object' then
    return null;
  end if;
  for i in 1 .. array_length(v_parts, 1) loop
    select count(*), (array_agg(n))[1] into v_n, v_node
      from jsonb_path_query(v_scope, 'strict $.** ? (@.id == $id && (@.kind == "phase" || @.kind == "holdPoint" || @.kind == "libraryCall"))',
                            jsonb_build_object('id', v_parts[i])) n;
    if v_n is distinct from 1 then
      return null;
    end if;
    if i < array_length(v_parts, 1) then
      if v_node ->> 'kind' is distinct from 'libraryCall' then
        return null;
      end if;
      select count(*), (array_agg(e))[1] into v_n, v_el from jsonb_array_elements(v_els) e where e ->> 'ref' = v_node ->> 'element';
      if v_n is distinct from 1 or jsonb_typeof(v_el -> 'body') is distinct from 'object' or jsonb_typeof(v_el -> 'symbols') is distinct from 'array' then
        return null;
      end if;
      -- Each symbol of the element names what the call binds it to: an MBR item at the procedure's level, else the
      -- calling element's own symbol, read through that element's bindings.
      v_next := '{}'::jsonb;
      for s in select x from jsonb_array_elements(v_el -> 'symbols') x loop
        if jsonb_typeof(s) is distinct from 'string' or jsonb_typeof(v_node -> 'bind' -> (s #>> '{}')) is distinct from 'string' then
          return null;
        end if;
        if v_env is null then
          v_next := v_next || jsonb_build_object(s #>> '{}', v_node -> 'bind' -> (s #>> '{}'));
        elsif jsonb_typeof(v_env -> (v_node -> 'bind' ->> (s #>> '{}'))) = 'string' then
          v_next := v_next || jsonb_build_object(s #>> '{}', v_env -> (v_node -> 'bind' ->> (s #>> '{}')));
        else
          return null;
        end if;
      end loop;
      v_env := v_next;
      v_scope := v_el -> 'body';
    end if;
  end loop;
  if v_node ->> 'kind' is distinct from 'phase' or jsonb_typeof(v_node -> 'records') is distinct from 'array' then
    return null;
  end if;
  for s in select x from jsonb_array_elements(v_node -> 'records') x loop
    if jsonb_typeof(s) is distinct from 'string' then
      return null;
    elsif v_env is null then
      v_out := v_out || (s #>> '{}');
    elsif jsonb_typeof(v_env -> (s #>> '{}')) = 'string' then
      v_out := v_out || (v_env ->> (s #>> '{}'));
    else
      return null;
    end if;
  end loop;
  return v_out;
end
$$;

-- INV-25, PR-19 (T2 round 3): why weighing entry p_entry ({stepKey, kind, data}) of a batch of MBR content p_content
-- does not count into the quantity its phase records (header); NULL when it does or when it is no CONTAINER_WEIGHING or
-- OUTPUT_CONTAINER. The text completes "This <row> stores entry <id> ...".
create function recipe.weighing_item_problem(p_entry jsonb, p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind    text := p_entry ->> 'kind';
  v_data    jsonb := p_entry -> 'data';
  v_what    text;
  v_step    text;
  v_records text[];
  v_params  jsonb := case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]'::jsonb end;
  v_mass    text[] := '{}';
  v_unread  text;
  v_want    jsonb;
  v_unit    text;
  v_block   text;
  r         text;
  p         jsonb;
begin
  if v_kind is null or v_kind not in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER') then
    return null;
  end if;
  v_what := format('(%s) at %s', v_kind, coalesce(p_entry ->> 'stepKey', '(no step)'));
  if jsonb_typeof(v_data) is distinct from 'object' then
    return format('%s with no data, so no quantity it counts into', v_what);
  end if;
  v_step := split_part(coalesce(p_entry ->> 'stepKey', ''), '@', 1);
  v_records := recipe.phase_records(p_content, v_step);
  if v_records is null then
    return format('%s, whose step is no phase of the batch''s MBR the database can read', v_what);
  end if;
  -- Only the block that records such a weighing takes it: G-07 a dispensed container, G-22 an output container.
  v_block := recipe.step_node(p_content, v_step) -> 'block' ->> 'type';
  if v_block is distinct from (case v_kind when 'CONTAINER_WEIGHING' then 'G-07' else 'G-22' end) then
    return format('%s, whose phase %s is a %s step, which records no such weighing', v_what, v_step, coalesce(v_block, '(no block)'));
  end if;
  -- The mass quantities the phase records, in order (blocks/generic common.ts massItems; the first parameter of an id
  -- is the MBR's), and the first quantity before any of them whose unit the database does not read.
  foreach r in array v_records loop
    select q into p from jsonb_array_elements(v_params) with ordinality t(q, o) where q ->> 'id' = r order by o limit 1;
    if p is null or (p ->> 'valueType') is distinct from 'DECIMAL'
       or coalesce(nullif(p -> 'readings', 'null'::jsonb), '1'::jsonb) <> '1'::jsonb then
      continue;
    end if;
    case recipe.mass_unit_class(p -> 'unit')
      when 'MASS' then
        v_mass := v_mass || r;
      when 'UNKNOWN' then
        if cardinality(v_mass) = 0 and v_unread is null then
          v_unread := format('%s in %s', r, p ->> 'unit');
        end if;
      else
        null;
    end case;
  end loop;
  if v_kind = 'CONTAINER_WEIGHING' then
    -- G-07: one of the phase's mass quantities, the one the entry names.
    if jsonb_typeof(v_data -> 'item') is distinct from 'string' or not ((v_data ->> 'item') = any (v_mass)) then
      return format('%s counted into %s, where its phase %s records the mass quantities %s', v_what,
                    coalesce((v_data -> 'item')::text, '(no item)'), v_step, to_jsonb(v_mass)::text);
    end if;
  else
    -- G-22: the first mass quantity; none only when the phase records none. A quantity before it whose unit the
    -- database does not read could be the first: fail closed.
    if v_unread is not null then
      return format('%s, whose phase %s records %s, a unit the database cannot tell is a mass or not, so not which quantity the container counts into',
                    v_what, v_step, v_unread);
    end if;
    v_want := coalesce(to_jsonb(v_mass[1]), 'null'::jsonb);
    if (v_data -> 'item') is distinct from v_want then
      return format('%s counted into %s, where its phase %s counts it into %s', v_what,
                    coalesce((v_data -> 'item')::text, '(no item)'), v_step, v_want::text);
    end if;
  end if;
  -- The weight is counted into its quantity's unit: the same unit, or both metric mass units (0322).
  if jsonb_typeof(v_data -> 'item') = 'string' then
    select q ->> 'unit' into v_unit from jsonb_array_elements(v_params) with ordinality t(q, o) where q ->> 'id' = v_data ->> 'item' order by o limit 1;
    if jsonb_typeof(v_data -> 'unit') is distinct from 'string'
       or ((v_data ->> 'unit') is distinct from v_unit
           and (recipe.metric_mass_exponent(v_data ->> 'unit') is null or recipe.metric_mass_exponent(v_unit) is null)) then
      return format('%s weighed in %s, which is not counted into %s in %s (the same unit, or both metric mass units)', v_what,
                    coalesce(v_data ->> 'unit', '(no unit)'), v_data ->> 'item', v_unit);
    end if;
  end if;
  return null;
end
$$;

-- INV-25, PR-19 (T2 round 3): a weighing entry a row brings in counts into the quantity its phase records (EBMR-EXE-139)
-- (header). Raises; returns nothing.
create function recipe.execution_weighing_item_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_row     text;
  v_problem text;
  k         text;
  x         jsonb;
begin
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
                  where not coalesce((old.state -> 'entries') ? e.key, false) and e.value ->> 'kind' in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER')) then
    return null;
  end if;
  select pk.content into v_content
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash
   where b.id = new.batch_id;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  for k, x in select e.key, e.value
                from jsonb_each(new.state -> 'entries') e
               where not coalesce((old.state -> 'entries') ? e.key, false)
               order by e.key
  loop
    v_problem := recipe.weighing_item_problem(x, v_content);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row stores entry %s %s: a weighing counts into the quantity its phase records in the MBR, decided by the database, never by the entry (INV-25, PR-19). [EBMR-EXE-139]',
                         v_row, k, v_problem);
    end if;
  end loop;
  return null;
end
$$;

create trigger zm_execution_weighing_item after update on recipe.execution_state
  for each row execute function recipe.execution_weighing_item_check();

revoke all on function recipe.mass_unit_class(jsonb), recipe.phase_records(jsonb, text), recipe.weighing_item_problem(jsonb, jsonb),
  recipe.execution_weighing_item_check() from public;

reset role;
