-- Recipe core, decision 0026 release review R3 (PR-08, PR-49; O-9 (b)): the database judges a library block's values
-- against the formulation's limits as the generic handler does (library/block-version.ts), and the exceptions it adds
-- carry the facts that judgement gives them.
--
-- Handbook: modules/recipe-core.md
--
-- 1810 recipe.library_limits_problem checked only that some LIB_LIMIT_BREACH of the step and item came with a value
-- outside its limit. Now:
--   * R3-SQL-1: the exception's facts are those the engine gives the tier breached (exceptions.ts tierDraft, tx.ts raise,
--     as recipe.limit_exception_record (0305) derives them for an MBR parameter): category, controls, severity, need of a
--     deviation, QA-only, registration, stage and release flags, block (steps, until, downstream node and frames),
--     source (step instance, step, frames, item) and raiser (the person who recorded the entry), and its title ends with
--     the tier breached ("[registered tier]"). The rest of the title is the engine's wording and is not compared. A row
--     adds exactly the LIB_LIMIT_BREACH exceptions its new entries require, one for one: an action breach stored as an
--     alert, or without its need of a deviation, is refused, so check_disposition_state (0270) can no longer accept
--     NO_IMPACT for it; a LIB_LIMIT_BREACH that no value of the row breaches is refused too, also from a row that adds
--     no entry.
--
--   recipe.library_breach_record: new. recipe.library_limits_problem, recipe.library_limits_check: CREATE OR REPLACE from
--   their latest definitions (1810). The trigger zzg_library_limits is unchanged.

set local role ebmr_owner;

-- The LIB_LIMIT_BREACH the engine raises for verdict p_ev (recipe.limit_reading) of item p_item against limits p_spec, in
-- step instance p_inst (node p_node), recorded by person p_by: every fact but its id, title and time of raising, and the
-- title's tier mark (tierTag). NULL when the verdict breaches no tier. The engine raises a library breach as the
-- parameter's LIMIT_BREACH under the library's own type, with no tier member (tx.ts raise of a block's draft).
create function recipe.library_breach_record(p_spec jsonb, p_ev jsonb, p_inst jsonb, p_node text, p_item text, p_by text) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when q.r is not null then
           (q.r - 'tier' - 'title') || jsonb_build_object('type', 'LIB_LIMIT_BREACH', 'tierTag', ' [' || regexp_replace(lower(p_ev ->> 'breached'), '_', ' ') || ' tier]')
         end
    from (select recipe.limit_exception_record('PARAMETER', '', p_item, p_spec, p_ev, p_inst, p_node, '{}'::jsonb, p_by) as r) q
$$;

-- PR-08 (header): library values against the formulation's limits; the row adds exactly the exceptions they require.
create or replace function recipe.library_limits_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
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
  v_inst   jsonb;
  d        jsonb;
  s        jsonb;
  f        jsonb;
  x        jsonb;
  v_val    text;
  v_unit   text;
  v_spec   jsonb;
  v_ev     jsonb;
  v_until  text;
  v_item   text;
  v_want   jsonb[] := '{}';
  v_what   text[] := '{}';
  v_used   boolean[] := '{}';
  v_hit    integer;
  v_extra  text;
begin
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) order by y.key loop
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    if coalesce(v_node -> 'block' ->> 'type', '') not like 'LIB-%' then
      continue;
    end if;
    d := recipe.library_definition(p_content, v_node -> 'block');
    if d is null then
      return format('stores entry %s of step %s, whose library block %s@%s is not in the master''s snapshots', k, v_step, v_node -> 'block' ->> 'type', v_node -> 'block' ->> 'version');
    end if;
    v_inst := recipe.limit_instance(p_new, e ->> 'stepKey', v_step);
    if e ->> 'kind' = 'TIMER_STOP' then
      select y into f from jsonb_array_elements(d -> 'sections') sec, jsonb_array_elements(sec -> 'fields') y where y ->> 'id' = e -> 'data' ->> 'field' limit 1;
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
        if v_ev ->> 'breached' is not null then
          if v_inst is null then
            return format('stores timer %s at step %s outside its %s limit in step instance %s, which the state does not hold', f ->> 'id', v_step, lower(v_ev ->> 'breached'), e ->> 'stepKey');
          end if;
          v_item := v_step || '.' || (f ->> 'id');
          v_want := v_want || recipe.library_breach_record(v_spec, v_ev, v_inst, recipe.step_graph_node(p_content, v_step), v_item, e ->> 'enteredBy');
          v_what := v_what || format('timer %s at step %s with %s %s, outside its %s limit,', f ->> 'id', v_step, v_val, v_unit, lower(v_ev ->> 'breached'));
          v_used := v_used || false;
        end if;
      end if;
      continue;
    end if;
    select y into s from jsonb_array_elements(d -> 'sections') y where y ->> 'id' = e ->> 'kind' limit 1;
    if s is null then
      continue;
    end if;
    v_until := case when s -> 'repeat' ->> 'kind' = 'UNTIL_PASS' then s -> 'repeat' ->> 'untilField' end;
    for f in select y from jsonb_array_elements(s -> 'fields') y
              where y ->> 'type' in ('NUMBER', 'WEIGHING', 'CALC') and y ? 'limitSlot' and (y ->> 'id') is distinct from v_until loop
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
      if v_ev ->> 'breached' is not null then
        if v_inst is null then
          return format('stores %s = %s %s at step %s outside its %s limit in step instance %s, which the state does not hold', f ->> 'id', v_val, f ->> 'unit', v_step, lower(v_ev ->> 'breached'), e ->> 'stepKey');
        end if;
        v_item := v_step || '.' || (f ->> 'id');
        v_want := v_want || recipe.library_breach_record(v_spec, v_ev, v_inst, recipe.step_graph_node(p_content, v_step), v_item, e ->> 'enteredBy');
        v_what := v_what || format('%s = %s %s at step %s, outside its %s limit,', f ->> 'id', v_val, f ->> 'unit', v_step, lower(v_ev ->> 'breached'));
        v_used := v_used || false;
      end if;
    end loop;
  end loop;
  -- The row's new library limit exceptions, one for one with the records its values require (R3-SQL-1).
  for k, x in select y.key, y.value from jsonb_each(x1) y
               where not (x0 ? y.key) and jsonb_typeof(y.value) = 'object' and y.value ->> 'type' = 'LIB_LIMIT_BREACH' order by y.key loop
    v_hit := null;
    for i in 1 .. coalesce(array_length(v_want, 1), 0) loop
      if not v_used[i] and x ->> 'id' = k
         and (x - 'id' - 'title' - 'raisedAt' - 'raisedSeq') || jsonb_strip_nulls(jsonb_build_object('tierTag', substring(x ->> 'title' from ' \[[a-z ]+ tier\]$'))) = v_want[i] then
        v_hit := i;
        exit;
      end if;
    end loop;
    if v_hit is null then
      v_extra := coalesce(v_extra, format('adds exception %s (%s, severity %s, item %s), which no value of the row requires with these facts', k, x ->> 'type',
                                          coalesce(x ->> 'severity', 'none'), coalesce(x -> 'source' ->> 'item', 'none')));
    else
      v_used[v_hit] := true;
    end if;
  end loop;
  -- A value without its exception is named first (an exception with other facts is then the reason it is missing).
  for i in 1 .. coalesce(array_length(v_want, 1), 0) loop
    if not v_used[i] then
      return format('stores %s without the %s it requires (severity %s, deviation %s)', v_what[i], v_want[i] ->> 'type', v_want[i] ->> 'severity',
                    case when (v_want[i] -> 'deviationRequired') = 'true'::jsonb then 'required' else 'not required' end);
    end if;
  end loop;
  return v_extra;
end
$$;

-- The trigger runs for a row that adds an entry, or a library limit exception (R3-SQL-1: one added for no value is refused).
create or replace function recipe.library_limits_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and not exists (select 1
                       from jsonb_each(case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end) x
                      where not coalesce((old.state -> 'exceptions') ? x.key, false) and x.value ->> 'type' in ('LIB_LIMIT_BREACH', 'LIB_REPEAT_LIMIT_REACHED')) then
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

revoke all on function recipe.library_breach_record(jsonb, jsonb, jsonb, text, text, text) from public;

reset role;
