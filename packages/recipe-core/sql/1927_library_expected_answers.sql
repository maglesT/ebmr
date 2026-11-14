-- Recipe core, injectables review pass item 3 (lead's ruling of 14 November 2026; PR-29, PR-08; decision 0008 section 2):
-- the database re-checks the expected yes/no answers and the not-allowed choices of a library block, as the generic
-- handler does (library/block-version.ts), and the row adds exactly the exceptions they require.
--
-- Handbook: modules/recipe-core.md
--
-- 1862 recipe.library_limits_problem judged a library entry's numbers, weighings, calculated figures, timers, test
-- results and loops against the formulation's limits. The engine also raises, for a field the entry shows:
--   * LIB_UNEXPECTED_ANSWER for a YES_NO field answered other than its `expected` (ACTION: the step blocked until a
--     deviation is linked; with `unexpectedCritical`, CRITICAL: QA only, the step and the steps after it blocked, release
--     blocked);
--   * LIB_NOT_ALLOWED_CHOICE for a CHOICE among the field's `notAllowed` (ACTION, the step blocked until a deviation).
-- The database checked neither, so a write through the application role could store "no" for an expected "yes" without
-- the exception, and no deviation opened and no release interlock fired. Now recipe.library_answer_records gives the
-- exception records those answers require, with every fact tx.ts raise gives them but id, title and time of raising,
-- and recipe.library_limits_problem adds them to the records the row must carry, one for one: an omitted exception, a
-- weakened one (a critical answer stored as ACTION) and one added for no unexpected answer are refused. A field its
-- condition (showWhen) hides is not judged, nor a loop's (UNTIL_PASS) YES_NO endpoint, nor any other endpoint before the
-- loop is exhausted, as in the engine.
--
-- Carried forward: recipe.library_limits_problem and recipe.library_limits_check are CREATE OR REPLACE from their 1862
-- text. Nothing of it is removed. The body differs from 1862 only by
--   * the block "Expected answers and allowed choices" added after the loop over the numeric fields;
--   * the two type lists of the exceptions matched (in both functions), which add LIB_UNEXPECTED_ANSWER and
--     LIB_NOT_ALLOWED_CHOICE to LIB_LIMIT_BREACH and LIB_REPEAT_LIMIT_REACHED.
-- The diff is docs/build-plan/injectables/expected-answer-db-1862.diff, and the test
-- packages/recipe-core/test/library/expected-answer-db.test.ts compares the two bodies line by line.
--
--   recipe.library_answer_records: new. recipe.library_limits_problem, recipe.library_limits_check: CREATE OR REPLACE from
--   1862. The trigger zzg_library_limits is unchanged. Rows written before this migration are not judged again (the
--   trigger judges the entries a row adds).

set local role ebmr_owner;

-- The exception records the answers of entry data p_data of section p_section require (block-version.ts accept), in the
-- order of the section's fields, each as {want, what}: want holds every fact tx.ts raise gives the engine's draft but its
-- id, title and time of raising; what names the answer for a refusal. A field is judged when the entry holds it and its
-- condition shows it; the loop endpoint p_until is not judged unless the loop is exhausted (p_exhausted), and a YES_NO
-- endpoint never. The step instance is p_inst (node p_node of step p_step), the person who recorded the entry p_by.
create function recipe.library_answer_records(p_section jsonb, p_data jsonb, p_until text, p_exhausted boolean, p_inst jsonb, p_node text, p_step text, p_by text)
returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'want', jsonb_build_object(
             'type', case when q.f ->> 'type' = 'YES_NO' then 'LIB_UNEXPECTED_ANSWER' else 'LIB_NOT_ALLOWED_CHOICE' end,
             'category', 'OUT_OF_LIMIT', 'controls', '["PR-29"]'::jsonb, 'severity', case when q.crit then 'CRITICAL' else 'ACTION' end,
             'source', jsonb_build_object('stepKey', p_inst -> 'key', 'step', p_inst -> 'step', 'frames', p_inst -> 'frames', 'item', p_step || '.' || (q.f ->> 'id')),
             'raisedBy', p_by, 'deviationRequired', true, 'registrationRelevant', false, 'qaOnly', q.crit, 'stageSignOffBlocked', false,
             'releaseBlocking', q.crit, 'status', 'OPEN',
             -- ACTION blocks the step; a critical answer the step and the steps after it (tx.ts raise of blocks
             -- STEP_AND_DOWNSTREAM), each until a deviation is linked.
             'block', jsonb_build_object('steps', jsonb_build_array(p_inst -> 'key'), 'until', 'DEVIATION')
                      || case when q.crit then jsonb_build_object('downstream', jsonb_build_object('node', p_node, 'frames', p_inst -> 'frames')) else '{}'::jsonb end),
           'what', case when q.f ->> 'type' = 'YES_NO'
                        then format('%s answered %s at step %s, where %s is expected,', q.f ->> 'id', q.v, p_step, q.f -> 'expected')
                        else format('%s = %s at step %s, a choice the formulation does not allow,', q.f ->> 'id', q.v, p_step) end)
         order by q.n), '[]'::jsonb)
    from (select f.f, f.n, p_data -> (f.f ->> 'id') as v, coalesce((f.f -> 'unexpectedCritical') = 'true'::jsonb, false) and f.f ->> 'type' = 'YES_NO' as crit
            from jsonb_array_elements(case when jsonb_typeof(p_section -> 'fields') = 'array' then p_section -> 'fields' else '[]'::jsonb end) with ordinality f (f, n)
           where jsonb_typeof(p_data) = 'object' and p_data ? (f.f ->> 'id')
             -- block-version.ts shown: no condition, or its field holds the given answer.
             and (not (f.f ? 'showWhen') or (p_data -> (f.f -> 'showWhen' ->> 'field')) = (f.f -> 'showWhen' -> 'equals'))
             -- A loop's endpoint is judged by the loop; once exhausted, any but a YES_NO is judged like any value.
             and not coalesce((f.f ->> 'id') = p_until and (not p_exhausted or f.f ->> 'type' = 'YES_NO'), false)) q
   where (q.f ->> 'type' = 'YES_NO' and q.f ? 'expected' and q.v is distinct from q.f -> 'expected')
      or (q.f ->> 'type' = 'CHOICE' and jsonb_typeof(q.f -> 'notAllowed') = 'array'
          and (q.f -> 'notAllowed') @> jsonb_build_array(case when jsonb_typeof(q.v) = 'null' then 'null' else q.v #>> '{}' end))
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
  v_n      integer;
  v_last   jsonb;
  v_max    integer;
  v_pass   boolean;
  v_exhausted boolean;
  v_opt    jsonb[] := '{}';
  v_opt_used boolean[] := '{}';
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
    -- R3-SQL-4: a loop (UNTIL_PASS) is decided as the engine decides it: no repeat after a pass or beyond the maximum,
    -- and the last allowed repeat without a pass exhausts it: its endpoint is judged against its tier and the
    -- LIB_REPEAT_LIMIT_REACHED it raises has an MBR loop's LOOP_EXHAUSTED consequences (R3-ENG-1).
    v_exhausted := false;
    if v_until is not null then
      select count(*), (array_agg(y.value -> 'data' order by y.value -> 'recordedSeq' desc))[1] into v_n, v_last
        from jsonb_each(e1) y
       where y.key <> k and y.value ->> 'kind' = e ->> 'kind' and y.value ->> 'stepKey' = e ->> 'stepKey' and (y.value -> 'recordedSeq') < (e -> 'recordedSeq');
      v_max := case when (v_node -> 'config' -> 'counts' ->> (s -> 'repeat' ->> 'maxRepeatsSlot')) ~ '^[0-9]{1,7}$'
                    then (v_node -> 'config' -> 'counts' ->> (s -> 'repeat' ->> 'maxRepeatsSlot'))::integer end;
      if v_max is not null and v_n >= v_max then
        return format('stores repeat %s of section %s at step %s, beyond its maximum of %s', v_n + 1, s ->> 'id', v_step, v_max);
      end if;
      v_pass := case when v_n = 0 then false else recipe.library_loop_pass(s, v_last, v_node -> 'config') end;
      if v_pass then
        return format('stores a repeat of section %s at step %s after it passed', s ->> 'id', v_step);
      end if;
      if v_pass is not null then
        v_pass := recipe.library_loop_pass(s, e -> 'data', v_node -> 'config');
      end if;
      if v_pass is null then
        return format('stores section %s at step %s, whose loop field %s the database cannot read against its limit', s ->> 'id', v_step, v_until);
      end if;
      v_exhausted := v_max is not null and v_n + 1 >= v_max and not v_pass;
      if v_exhausted then
        if v_inst is null then
          return format('stores the last repeat of section %s at step %s without a pass in step instance %s, which the state does not hold', s ->> 'id', v_step, e ->> 'stepKey');
        end if;
        v_want := v_want || jsonb_build_object(
          'type', 'LIB_REPEAT_LIMIT_REACHED', 'category', 'OUT_OF_LIMIT', 'controls', '["PR-08", "INV-20"]'::jsonb, 'severity', 'ACTION',
          'source', jsonb_build_object('stepKey', v_inst -> 'key', 'step', v_inst -> 'step', 'frames', v_inst -> 'frames', 'item', v_step || '.' || v_until),
          'raisedBy', e -> 'enteredBy', 'deviationRequired', true, 'registrationRelevant', false, 'qaOnly', true, 'stageSignOffBlocked', false,
          'releaseBlocking', true, 'status', 'OPEN',
          'block', jsonb_build_object('steps', '[]'::jsonb, 'until', 'DISPOSITION',
                                      'downstream', jsonb_build_object('node', recipe.step_graph_node(p_content, v_step), 'frames', v_inst -> 'frames')));
        v_what := v_what || format('the last allowed repeat (%s) of section %s at step %s, which did not pass,', v_max, s ->> 'id', v_step);
        v_used := v_used || false;
      end if;
    end if;
    for f in select y from jsonb_array_elements(s -> 'fields') y
              where y ->> 'type' in ('NUMBER', 'WEIGHING', 'CALC') and y ? 'limitSlot' and ((y ->> 'id') is distinct from v_until or v_exhausted) loop
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
    -- Expected answers and allowed choices (1927): a YES_NO field the entry shows, answered other than its expected answer,
    -- requires its LIB_UNEXPECTED_ANSWER, and a CHOICE the formulation does not allow its LIB_NOT_ALLOWED_CHOICE
    -- (block-version.ts accept; recipe.library_answer_records).
    for x in select r from jsonb_array_elements(recipe.library_answer_records(s, e -> 'data', v_until, v_exhausted, v_inst, recipe.step_graph_node(p_content, v_step), v_step, e ->> 'enteredBy')) r loop
      if v_inst is null then
        return format('stores %s in step instance %s, which the state does not hold', x ->> 'what', e ->> 'stepKey');
      end if;
      v_want := v_want || (x -> 'want');
      v_what := v_what || (x ->> 'what');
      v_used := v_used || false;
    end loop;
    -- Test results (R3-SQL-2): each statistic's values, of the readings or of each point's readings, against its limits.
    for f in select y from jsonb_array_elements(s -> 'fields') y where y ->> 'type' = 'TEST_RESULT' and e -> 'data' ? (y ->> 'id') loop
      v_item := v_step || '.' || (f ->> 'id');
      -- One judgement per statistic, and per point of a profile.
      for st, v_pt in select q1.st, case when (f -> 'perPoint') = 'true'::jsonb then p.pt end
                        from jsonb_array_elements(case when jsonb_typeof(f -> 'statistics') = 'array' then f -> 'statistics' else '[]'::jsonb end) with ordinality q1 (st, n1)
                        cross join jsonb_array_elements(case when (f -> 'perPoint') = 'true'::jsonb
                                                             then case when jsonb_typeof(v_node -> 'config' -> 'points' -> (f ->> 'id')) = 'array' then v_node -> 'config' -> 'points' -> (f ->> 'id') else '[]'::jsonb end
                                                             else '[null]'::jsonb end) with ordinality p (pt, n2)
                       order by q1.n1, p.n2 loop
        v_spec := case when v_pt is not null then v_pt -> 'limits' else v_node -> 'config' -> 'limits' -> (st ->> 'limitSlot') end;
        if v_spec is null then
          continue;
        end if;
        -- RSD needs a square root at the engine's precision, which the database does not take: the engine's breach of it is
        -- admitted (not required) when its facts are those of one of the limit's tiers.
        if st ->> 'statistic' = 'RSD' then
          if v_inst is not null then
            for x in select r from jsonb_array_elements(case when jsonb_typeof(v_spec -> 'ranges') = 'array' then v_spec -> 'ranges' else '[]'::jsonb end) r loop
              v_ev := jsonb_build_object('breached', x -> 'tier', 'rank', case x ->> 'tier' when 'ALERT' then 1 when 'INTERNAL_ACTION' then 2 when 'REGISTERED' then 3 when 'VALIDATED' then 3 end,
                                         'continueAllowed', x ->> 'tier' = 'INTERNAL_ACTION' and (v_spec -> 'actionBreach') = '"CONTINUE_CURRENT_STEP_WITH_DEVIATION"'::jsonb);
              v_opt := v_opt || recipe.library_breach_record(v_spec, v_ev, v_inst, recipe.step_graph_node(p_content, v_step), v_item, e ->> 'enteredBy');
              v_opt_used := v_opt_used || false;
            end loop;
          end if;
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
  -- The row's new library limit and loop exceptions, one for one with the records its values require (R3-SQL-1, R3-SQL-4).
  for k, x in select y.key, y.value from jsonb_each(x1) y
               where not (x0 ? y.key) and jsonb_typeof(y.value) = 'object' and y.value ->> 'type' in ('LIB_LIMIT_BREACH', 'LIB_REPEAT_LIMIT_REACHED', 'LIB_UNEXPECTED_ANSWER', 'LIB_NOT_ALLOWED_CHOICE') order by y.key loop
    v_hit := null;
    for i in 1 .. coalesce(array_length(v_want, 1), 0) loop
      if not v_used[i] and x ->> 'id' = k
         and (x - 'id' - 'title' - 'raisedAt' - 'raisedSeq') || jsonb_strip_nulls(jsonb_build_object('tierTag', substring(x ->> 'title' from ' \[[a-z ]+ tier\]$'))) = v_want[i] then
        v_hit := i;
        exit;
      end if;
    end loop;
    if v_hit is null then
      -- An engine's RSD breach the row's judgement admits (each once).
      for i in 1 .. coalesce(array_length(v_opt, 1), 0) loop
        if not v_opt_used[i] and x ->> 'id' = k
           and (x - 'id' - 'title' - 'raisedAt' - 'raisedSeq') || jsonb_strip_nulls(jsonb_build_object('tierTag', substring(x ->> 'title' from ' \[[a-z ]+ tier\]$'))) = v_opt[i] then
          v_opt_used[i] := true;
          v_hit := 0;
          exit;
        end if;
      end loop;
    end if;
    if v_hit = 0 then
      continue;
    end if;
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
                      where not coalesce((old.state -> 'exceptions') ? x.key, false) and x.value ->> 'type' in ('LIB_LIMIT_BREACH', 'LIB_REPEAT_LIMIT_REACHED', 'LIB_UNEXPECTED_ANSWER', 'LIB_NOT_ALLOWED_CHOICE')) then
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

revoke all on function recipe.library_answer_records(jsonb, jsonb, text, boolean, jsonb, text, text, text) from public;

reset role;
