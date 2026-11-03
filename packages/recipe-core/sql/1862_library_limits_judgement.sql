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
--   * R3-SQL-2: test results are judged (1810 skipped them, so a 270 mg tablet against 237.5-262.5 mg was stored with no
--     exception): each statistic but RSD (individual readings, minimum, maximum, mean, range; plain decimal arithmetic
--     on the entered readings), of the readings or of each point's readings for a profile, against the slot's limits
--     or the point's; per statistic and point, the most severe tier any value breaches requires its exception (R3-ENG-2).
--     RSD needs a square root at the engine's precision; it stays the engine's judgement.
--   * R3-SQL-3: a timer's duration is no longer the application's figure: the database works it out from the trusted
--     recordedAt of the timer's start and of its stop, in the field's duration unit (ms, s, min, h or d, the units the
--     engine's durations hold), and refuses a stop without its start, another figure or another unit.
--   * R3-SQL-5: a calculated field with no computed figure was skipped. Every calculated field an entry shows (no
--     condition, or its condition's field holds the given answer) now carries its evaluation record (O-9 (b)): a decimal
--     value in the field's unit, the expression of the master's snapshot, a language version and the inputs read; a field
--     its condition hides carries none. The figure itself stays the server's (O-9 (b): not recomputed in SQL).
--
--   recipe.library_breach_record, recipe.library_statistic, recipe.library_timer_duration: new. recipe.library_limits_problem, recipe.library_limits_check: CREATE OR REPLACE from
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

-- The values statistic p_stat (INDIVIDUAL, MIN, MAX, MEAN, RANGE) gives of readings p_readings, as library/block-version.ts
-- statistic() does: every reading, or the one value; none for no reading. NULL when the readings are not a list of
-- decimals written as text, or for another statistic (RSD is not judged here). The mean is exact to 40 decimals where
-- the engine keeps 34 significant digits: the limits round a value at their own decimals or significant figures first,
-- so the two give the same verdict.
create function recipe.library_statistic(p_stat text, p_readings jsonb) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when jsonb_typeof(p_readings) is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(p_readings) r where jsonb_typeof(r) is distinct from 'string' or (r #>> '{}') !~ '^-?[0-9]+(\.[0-9]+)?$')
      then null
    when jsonb_array_length(p_readings) = 0 then case when p_stat in ('INDIVIDUAL', 'MIN', 'MAX', 'MEAN', 'RANGE') then '{}'::text[] end
    when p_stat = 'INDIVIDUAL' then array(select r #>> '{}' from jsonb_array_elements(p_readings) with ordinality a (r, n) order by n)
    else (select case p_stat
                   when 'MIN' then array[trim_scale(min(v))::text]
                   when 'MAX' then array[trim_scale(max(v))::text]
                   when 'RANGE' then array[trim_scale(max(v) - min(v))::text]
                   when 'MEAN' then array[trim_scale(round(sum(v)::numeric(1000, 40) / count(*), 40))::text]
                 end
            from (select (r #>> '{}')::numeric as v from jsonb_array_elements(p_readings) r) q)
  end
$$;

-- The duration from p_start to p_stop (epoch microseconds) in time unit p_unit, as block-version.ts acceptTimer gives it:
-- the exact quotient, rounded to 34 significant digits as @ebmr/expr's Dec divides (half-even; a quotient that needs
-- rounding has a factor 3 or 7 in its divisor and so never ends in an exact half), written without trailing zeros. NULL
-- for a time unit the engine's durations do not hold, or times that are not in order.
create function recipe.library_timer_duration(p_start bigint, p_stop bigint, p_unit text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when q.us is null or q.per is null then null
              when q.us = 0 then '0'
              else (select trim_scale(round(r.v, 33 - floor(log(r.v))::integer))::text from (select q.us::numeric(1000, 60) / q.per as v) r)
         end
    from (select case when p_stop >= p_start then p_stop - p_start end as us,
                 (case p_unit when 'ms' then 1000 when 's' then 1000000 when 'min' then 60000000 when 'h' then 3600000000 when 'd' then 86400000000 end)::numeric as per) q
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
  st       jsonb;
  v_pt     jsonb;
  v_vals   text[];
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
      select y into f from jsonb_array_elements(d -> 'sections') sec, jsonb_array_elements(sec -> 'fields') y
       where y ->> 'id' = e -> 'data' ->> 'field' and y ->> 'type' = 'TIMER' limit 1;
      if f is null then
        continue;
      end if;
      -- R3-SQL-3: the duration is the time from the timer's start to this stop, both recorded on trusted time, in the
      -- field's unit (block-version.ts acceptTimer); the application's figure is compared with it.
      v_unit := coalesce(f ->> 'durationUnit', 'min');
      select y.value into x from jsonb_each(e1) y
       where y.value ->> 'kind' = 'TIMER_START' and y.value ->> 'stepKey' = e ->> 'stepKey' and y.value -> 'data' ->> 'field' = f ->> 'id'
       order by recipe.micros_of(y.value -> 'recordedAt') limit 1;
      if x is null then
        return format('stores the stop of timer %s at step %s without its start', f ->> 'id', v_step);
      end if;
      v_val := recipe.library_timer_duration(recipe.micros_of(x -> 'recordedAt'), recipe.micros_of(e -> 'recordedAt'), v_unit);
      if v_val is null then
        return format('stores the stop of timer %s at step %s, whose duration in %s the database cannot work out from its start and stop', f ->> 'id', v_step, v_unit);
      end if;
      if (e -> 'data' -> 'duration' -> 'unit') is distinct from to_jsonb(v_unit) or (e -> 'data' -> 'duration' -> 'value') is distinct from to_jsonb(v_val) then
        return format('stores timer %s at step %s with a duration of %s %s, where its start and stop on trusted time give %s %s', f ->> 'id', v_step,
                      coalesce(e -> 'data' -> 'duration' ->> 'value', 'none'), coalesce(e -> 'data' -> 'duration' ->> 'unit', '(no unit)'), v_val, v_unit);
      end if;
      v_spec := case when f ? 'limitSlot' then v_node -> 'config' -> 'limits' -> (f ->> 'limitSlot') end;
      if v_spec is not null then
        if (v_spec ->> 'unit') is distinct from v_unit then
          return format('stores timer %s at step %s, whose limit is not written in the timer''s unit %s', f ->> 'id', v_step, v_unit);
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
    -- R3-SQL-5 (O-9 (b)): a calculated field the entry shows carries the server's figure with its evaluation record (the
    -- value, in the field's unit, the snapshot's expression, the language version and the inputs read); one its condition
    -- hides carries none (block-version.ts shown: the condition's field holds the given answer).
    for f in select y from jsonb_array_elements(s -> 'fields') y where y ->> 'type' = 'CALC' loop
      x := e -> 'data' -> 'computed' -> (f ->> 'id');
      if f ? 'showWhen' and (e -> 'data' -> (f -> 'showWhen' ->> 'field')) is distinct from (f -> 'showWhen' -> 'equals') then
        if x is not null then
          return format('stores a calculated %s at step %s, which its condition hides', f ->> 'id', v_step);
        end if;
        continue;
      end if;
      if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x -> 'value') is distinct from 'string' or (x ->> 'value') !~ '^-?[0-9]+(\.[0-9]+)?$'
         or (x -> 'unit') is distinct from (f -> 'unit') or (x -> 'expression') is distinct from (f -> 'expression')
         or jsonb_typeof(x -> 'languageVersion') is distinct from 'string' or (x ->> 'languageVersion') = '' or jsonb_typeof(x -> 'inputs') is distinct from 'object' then
        return format('stores entry %s at step %s without the evaluation record of its calculated %s (a decimal value in %s, the expression of the master''s snapshot, the language version and the inputs read; O-9)',
                      k, v_step, f ->> 'id', f ->> 'unit');
      end if;
    end loop;
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
    -- Test results (R3-SQL-2): each statistic's values, of the readings or of each point's readings, against its limits.
    for f in select y from jsonb_array_elements(s -> 'fields') y where y ->> 'type' = 'TEST_RESULT' and e -> 'data' ? (y ->> 'id') loop
      v_item := v_step || '.' || (f ->> 'id');
      -- One judgement per statistic (RSD excepted: a square root the database does not take), and per point of a profile.
      for st, v_pt in select q1.st, case when (f -> 'perPoint') = 'true'::jsonb then p.pt end
                        from jsonb_array_elements(case when jsonb_typeof(f -> 'statistics') = 'array' then f -> 'statistics' else '[]'::jsonb end) with ordinality q1 (st, n1)
                        cross join jsonb_array_elements(case when (f -> 'perPoint') = 'true'::jsonb
                                                             then case when jsonb_typeof(v_node -> 'config' -> 'points' -> (f ->> 'id')) = 'array' then v_node -> 'config' -> 'points' -> (f ->> 'id') else '[]'::jsonb end
                                                             else '[null]'::jsonb end) with ordinality p (pt, n2)
                       where q1.st ->> 'statistic' is distinct from 'RSD'
                       order by q1.n1, p.n2 loop
        v_spec := case when v_pt is not null then v_pt -> 'limits' else v_node -> 'config' -> 'limits' -> (st ->> 'limitSlot') end;
        if v_spec is null then
          continue;
        end if;
        if (v_spec ->> 'unit') is distinct from (f ->> 'unit') then
          return format('stores %s at step %s, whose %s limit is not written in the field''s unit %s', f ->> 'id', v_step, lower(st ->> 'statistic'), f ->> 'unit');
        end if;
        v_vals := recipe.library_statistic(st ->> 'statistic',
                                           case when v_pt is not null then e -> 'data' -> (f ->> 'id') -> (v_pt ->> 'id') else e -> 'data' -> (f ->> 'id') end);
        if v_vals is null then
          return format('stores %s at step %s with readings the database cannot read', f ->> 'id', v_step);
        end if;
        -- The worst value governs: the most severe tier any value breaches, the first value at that tier (R3-ENG-2).
        v_ev := null;
        foreach v_val in array v_vals loop
          x := recipe.limit_reading(v_spec, v_val);
          if x is null then
            return format('stores %s = %s at step %s, which the database cannot read against its limit', f ->> 'id', v_val, v_step);
          end if;
          if v_ev is null or (x ->> 'rank')::integer > (v_ev ->> 'rank')::integer then
            v_ev := x;
          end if;
        end loop;
        if v_ev ->> 'breached' is not null then
          if v_inst is null then
            return format('stores %s at step %s outside its %s limit in step instance %s, which the state does not hold', f ->> 'id', v_step, lower(v_ev ->> 'breached'), e ->> 'stepKey');
          end if;
          v_want := v_want || recipe.library_breach_record(v_spec, v_ev, v_inst, recipe.step_graph_node(p_content, v_step), v_item, e ->> 'enteredBy');
          v_what := v_what || format('%s (%s%s) = %s %s at step %s, outside its %s limit,', f ->> 'id', lower(st ->> 'statistic'),
                                     case when v_pt is not null then ' at ' || (v_pt ->> 'id') else '' end, v_ev ->> 'value', f ->> 'unit', v_step, lower(v_ev ->> 'breached'));
          v_used := v_used || false;
        end if;
      end loop;
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

revoke all on function recipe.library_breach_record(jsonb, jsonb, jsonb, text, text, text), recipe.library_statistic(text, jsonb),
                       recipe.library_timer_duration(bigint, bigint, text) from public;

reset role;
