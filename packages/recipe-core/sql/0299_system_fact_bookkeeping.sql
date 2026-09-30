-- Recipe core, execution store (module C3): the database proves every fact it relies on before it records anything
-- as the system's own act (review finding P28, round-1 verification; DI-14, DI-27, INV-03, INV-20, DI-26, DI-37;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- 0280 records the first content version of a record the system created in a person's row (a time fact, a hold
-- point the token advance enabled) under an internal system identity, so the person whose call noticed a breach or
-- whose release enabled the next hold point is not logged as having changed it (esig.content_change) and may still
-- decide it (INV-03, EBMR-ESIG-044). That attribution rested on facts the application role writes and nothing
-- checked: the time bookkeeping of the state (the node events, the constraint instances, the last time seen) and the
-- free-text title of the breach. The round-1 verification showed three forgeries through the application role that
-- the database accepted, each ending with a record the person made logged as the system's creation (in A, also
-- dispositioned by that person):
--   A. the person's own text written into a real breach (its title), the rest of the breach kept;
--   B. a start event that never happened (a node event ten seconds in the past) and its constraint instance;
--   C. a last time seen planted an hour ahead, so that the next row could claim a regression of the clock.
-- Also: a row could add an exception or a hold point without its first content version (contents []), and the
-- malformed-entry check of recipe.insert_contents let an entry without content through (NULL in an IF).
--
-- The rule now is fail-safe: a first version is the system's only when the database has proved every input the
-- attribution relies on; otherwise it is stored under the validated person, which is stricter. This migration:
--
--   1. The last time seen (lastRecordedUs) of every row's state is the later of the previous state's and the row's
--      trusted database time (recipe.execution_clock, INV-16), as the engine keeps it (engine.ts openTx); at issue it
--      is the row's time (EBMR-EXE-025).
--   2. Node events are kept for good: a row never changes or removes one (EBMR-EXE-026). A node event a row adds is
--      well formed (its key is node|event|context of its own frames) and is at the row's trusted time, never earlier
--      and never later (EBMR-EXE-025). A time the engine takes from a device (DEVICE_SYNCED) is not accepted yet: no
--      evidence the database can attest carries it (the server sends none), so the database's own time is the only
--      one it accepts. A node event is added only by the act that records it (EBMR-EXE-026): a phase's START by its
--      own accepted START_STEP, its END by its own accepted SIGN_PERFORMED, a hold point's START by the row that
--      creates the hold point, its END by its own accepted DISPOSITION_HOLD_POINT; a construct's start or end (a
--      stage, a loop, a parallel or alternative section, a replicate section) only by the token advance of an
--      accepted command or of the issue. A signing preparation, a time sweep and a refused command add none.
--   3. Constraint instances (timeInstances) keep their key, constraint and frames, a breach recorded on them, and a
--      warning or void once given (EBMR-EXE-026). A breach mark a row sets names an exception that row raises, of the
--      mark's kind, for that constraint and those frames (EBMR-EXE-026); a new instance is well formed.
--   4. A step instance a row adds is told by that row's STEP_STATUS_CHANGED event from PENDING (EBMR-EXE-048).
--   5. A time fact raised by SYSTEM (recipe.time_fact_problem, EBMR-EXE-046) is, field for field, the exception the
--      engine writes (timing.ts raiseTimeException, tx.ts raise, exceptions.ts): its title is the constraint's name
--      (the MBR's own name, "Hold time of <intermediate>" or "Maximum duration of <loop>") with the fixed wording,
--      the limit and an elapsed time the recorded times give (recipe.format_micros, as flow/decimal.ts formatMicros);
--      its category, controls, severity, flags, source, time of raising and block (the steps it stops, as a set, and
--      the node it stops downstream of, recipe.flow_anchor) are derived too. A clock regression is the engine's
--      fixed record. Only raisedSeq, the sequence number, is left to the engine.
--   6. Completeness (recipe.insert_contents, EBMR-EXE-057): every exception a row raises (its EXCEPTION_RAISED
--      event) and every hold point it creates (its STEP_STATUS_CHANGED event from PENDING) has its first content
--      version stored by that row. The malformed-entry check is NULL-safe (EBMR-EXE-055).
--   7. The attribution (recipe.created_by_system): the stored first version of a time fact equals, in full, the
--      content the engine derives from the validated exception (recipe.exception_content_of, as signing-content.ts
--      exceptionSigningContent), header included.
--   8. The internal identity (recipe.system_actor) carries the role code EXECUTION_ENGINE, which no catalogue role
--      has and so no account holds (like SOFTWARE_RELEASE), instead of EXECUTION_SWEEPER, the sweeper service's own
--      role: an audit entry of the system's creation is never taken for an act of the sweeper.
--
-- What stays with the replay verification (ADR 0010), stated so the checks above are not over-read: the database does
-- not re-run the token advance, so a construct's start or end added by an accepted command at that command's time
-- is taken as recorded; the content of a hold point the advance creates is compared with the state only as far as
-- 0280 does (no entry, no person, its own event); and the rest of the engine state is checked by replay, as before.
-- Owner decisions (docs/decisions/phase-2-open-questions.md, X1 and X2): exceptions the token advance raises from the
-- MBR's flow (DECISION_NOT_EVALUABLE, REPLICATE_COUNT_INVALID, LOOP_EXHAUSTED, a limit verdict at a loop exit) stay
-- raised by the person whose command ran the advance, and a stage frame's first version stays that person's change.
--
-- Messages: EBMR-EXE-025 (time bookkeeping not at the database's time), EBMR-EXE-026 (node events or constraint
-- instances changed, malformed, or added by a row whose act does not record them), EBMR-EXE-046 (as 0280, now also the
-- title and facts), EBMR-EXE-048 (a step instance without its event), EBMR-EXE-057 (a created record without its
-- first content version). CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the search_path and the
-- privileges of 0210/0280 (owner only); the new helpers are private to the owner. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers (owner only)
-- ---------------------------------------------------------------------------------------------

-- A duration in microseconds as the engine writes it in an exception's title (flow/decimal.ts formatMicros): the
-- largest of d, h, min, s and ms that divides it, else seconds with six decimals.
create function recipe.format_micros(p_us bigint) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_abs   numeric := abs(p_us::numeric);
  v_sign  text := case when p_us < 0 then '-' else '' end;
  v_units text[] := array['d', 'h', 'min', 's', 'ms'];
  v_sizes numeric[] := array[86400000000, 3600000000, 60000000, 1000000, 1000];
  v_txt   text;
begin
  if p_us is null then
    return null;
  end if;
  for i in 1 .. 5 loop
    if v_abs <> 0 and mod(v_abs, v_sizes[i]) = 0 then
      return v_sign || div(v_abs, v_sizes[i])::text || ' ' || v_units[i];
    end if;
  end loop;
  v_txt := v_abs::text;
  if length(v_txt) < 7 then
    v_txt := lpad(v_txt, 7, '0');
  end if;
  return v_sign || left(v_txt, length(v_txt) - 6) || '.' || right(v_txt, 6) || ' s';
end
$$;

-- The title the engine gives a time breach (timing.ts raiseTimeException): the constraint's name, what happened with
-- the limit and the elapsed time, and what the breach stops.
create function recipe.time_fact_title(p_name text, p_max boolean, p_limit bigint, p_elapsed bigint, p_block boolean) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select p_name || ' ' || case when p_max then 'exceeded its maximum of ' else 'ended before its minimum of ' end
         || recipe.format_micros(p_limit) || ' (' || recipe.format_micros(p_elapsed) || ' elapsed)'
         || case when p_block then '; the step and the steps after it stop until QA dispositions the exception' else '; a deviation is required' end
$$;

-- The execution-graph node a breach of a constraint starting at tree node p_node stops downstream of (engine
-- definition.ts: the constraint's anchor, the task or hold node of a step, else the first graph node of the construct,
-- flow/compile.ts): task:<id>, hold:<id>, scope-start:<id>, and-split:<id>, xor-split:<id>, loop-entry:<id> or
-- rep-split:<id>. NULL when the MBR has no such node (fail closed).
create function recipe.flow_anchor(p_content jsonb, p_node text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_step jsonb := recipe.step_node(p_content, p_node);
  v_kind text;
  v_pref text;
begin
  if v_step is not null then
    return case v_step ->> 'kind' when 'phase' then 'task:' else 'hold:' end || p_node;
  end if;
  for v_kind, v_pref in select q.kind, q.prefix
                          from (values ('stage', 'scope-start:'), ('operation', 'scope-start:'), ('parallel', 'and-split:'), ('alternative', 'xor-split:'),
                                       ('loop', 'loop-entry:'), ('replicate', 'rep-split:')) q (kind, prefix) loop
    if recipe.flow_node_of(p_content, p_node, v_kind) is not null then
      return v_pref || p_node;
    end if;
  end loop;
  return null;
end
$$;

-- The step instances a breach of a constraint ending at step p_step stops, instance frames p_frames, in steps p_steps
-- (timing.ts raiseTimeException: the instances of the step within the constraint instance that are not completed,
-- not applicable or skipped), as a sorted array of keys. Empty when the constraint does not end at a step.
create function recipe.time_blocked_steps(p_steps jsonb, p_step text, p_frames jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(i.key) order by i.key), '[]'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_steps) = 'object' then p_steps else '{}'::jsonb end) i
   where p_step is not null and i.value ->> 'step' = p_step
     and coalesce(i.value ->> 'status', '') not in ('COMPLETED', 'NOT_APPLICABLE', 'SKIPPED')
     and not exists (select 1
                       from jsonb_array_elements(case when jsonb_typeof(i.value -> 'frames') = 'array' then i.value -> 'frames' else '[]'::jsonb end) f
                       join jsonb_array_elements(case when jsonb_typeof(p_frames) = 'array' then p_frames else '[]'::jsonb end) g
                         on g ->> 'construct' = f ->> 'construct'
                      where (g -> 'index') is distinct from (f -> 'index'))
$$;

-- The runtime time constraint p_id of MBR content p_content as the engine derives it (engine/definition.ts), now with
-- its name and breach behaviour: {from, to, max?, min?, name, breach}. The MBR's own list (its name and breach), the
-- hold time of an intermediate ("Hold time of <name>", EXCEPTION_AND_BLOCK) and the maximum duration of a loop
-- ("Maximum duration of <name>", EXCEPTION). NULL when the MBR has no such constraint. Replaces 0280's function (same
-- signature, owner, privileges); the rest of the derivation is unchanged.
create or replace function recipe.time_constraint_of(p_content jsonb, p_id text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_tc   jsonb;
  v_n    bigint;
  v_rest text[];
  v_pu   text[];
  v_p    jsonb;
  v_u    jsonb;
  v_loop jsonb;
begin
  if p_id is null or jsonb_typeof(p_content) is distinct from 'object' then
    return null;
  end if;
  if p_id like 'HOLD-TIME:%' then
    v_rest := string_to_array(substr(p_id, 11), ':');
    v_pu := string_to_array(v_rest[2], '>');
    if cardinality(v_rest) is distinct from 2 or cardinality(v_pu) is distinct from 2 then
      return null;
    end if;
    select count(*), (array_agg(i))[1] into v_n, v_tc
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'intermediates') = 'array' then p_content -> 'intermediates' else '[]'::jsonb end) i
     where i ->> 'id' = v_rest[1];
    v_p := recipe.step_node(p_content, v_pu[1]);
    v_u := recipe.step_node(p_content, v_pu[2]);
    if v_n is distinct from 1 or jsonb_typeof(v_tc -> 'holdTime' -> 'max') is distinct from 'object'
       or v_p ->> 'kind' is distinct from 'phase' or v_u ->> 'kind' is distinct from 'phase'
       or not coalesce(jsonb_typeof(v_p -> 'produces') = 'array' and (v_p -> 'produces') ? v_rest[1], false)
       or not coalesce(jsonb_typeof(v_u -> 'uses') = 'array' and (v_u -> 'uses') ? v_rest[1], false) then
      return null;
    end if;
    return jsonb_build_object('from', jsonb_build_object('node', v_pu[1], 'event', 'END'), 'to', jsonb_build_object('node', v_pu[2], 'event', 'START'),
                              'max', v_tc -> 'holdTime' -> 'max', 'name', 'Hold time of ' || (v_tc ->> 'name'), 'breach', 'EXCEPTION_AND_BLOCK');
  end if;
  if p_id like 'LOOP-MAX-DURATION:%' then
    v_loop := recipe.flow_node_of(p_content, substr(p_id, 19), 'loop');
    if jsonb_typeof(v_loop -> 'maxDuration') is distinct from 'object' then
      return null;
    end if;
    return jsonb_build_object('from', jsonb_build_object('node', substr(p_id, 19), 'event', 'START'), 'to', jsonb_build_object('node', substr(p_id, 19), 'event', 'END'),
                              'max', v_loop -> 'maxDuration', 'name', 'Maximum duration of ' || (v_loop ->> 'name'), 'breach', 'EXCEPTION');
  end if;
  select count(*), (array_agg(t))[1] into v_n, v_tc
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'timeConstraints') = 'array' then p_content -> 'timeConstraints' else '[]'::jsonb end) t
   where t ->> 'id' = p_id;
  if v_n is distinct from 1 or jsonb_typeof(v_tc -> 'from' -> 'node') is distinct from 'string' or jsonb_typeof(v_tc -> 'to' -> 'node') is distinct from 'string'
     or coalesce(v_tc -> 'from' ->> 'event', '') not in ('START', 'END') or coalesce(v_tc -> 'to' ->> 'event', '') not in ('START', 'END') then
    return null;
  end if;
  return jsonb_build_object('from', jsonb_build_object('node', v_tc -> 'from' ->> 'node', 'event', v_tc -> 'from' ->> 'event'),
                            'to', jsonb_build_object('node', v_tc -> 'to' ->> 'node', 'event', v_tc -> 'to' ->> 'event'),
                            'name', v_tc -> 'name', 'breach', v_tc -> 'breach')
         || jsonb_strip_nulls(jsonb_build_object('max', v_tc -> 'max', 'min', v_tc -> 'min'));
end
$$;

-- INV-20, DI-27: why a new time breach p_x (id p_key) raised by SYSTEM in a row at trusted time p_now, moving the
-- state from p_old (NULL for an issue) to p_new, is not the finding the engine makes there; NULL when it is. As 0280
-- (the constraint, the source, the instance, the recorded times), and now the whole record (header item 5): the
-- recorded times give the elapsed times the engine can have measured (for a maximum, the earliest late end of the
-- instance or, with no end, the transaction time; for a minimum, an end event this row recorded), and the title must
-- be the engine's text for one of them.
create or replace function recipe.time_fact_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_now bigint, p_key text, p_x jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_max     boolean := p_x ->> 'type' = 'TIME_MAX_BREACH';
  v_src     jsonb := p_x -> 'source';
  v_frames  jsonb := p_x -> 'source' -> 'frames';
  v_cons    text := p_x -> 'source' ->> 'constraint';
  v_rc      jsonb;
  v_limit   bigint;
  v_step    boolean;
  v_source  jsonb;
  v_field   text := case when p_x ->> 'type' = 'TIME_MAX_BREACH' then 'maxBreachException' else 'minBreachException' end;
  v_ev0     jsonb := case when jsonb_typeof(p_old -> 'nodeEvents') = 'object' then p_old -> 'nodeEvents' else '{}'::jsonb end;
  v_ev1     jsonb := case when jsonb_typeof(p_new -> 'nodeEvents') = 'object' then p_new -> 'nodeEvents' else '{}'::jsonb end;
  v_start0  bigint;
  v_start1  bigint;
  v_now     bigint := greatest(p_now, coalesce(recipe.micros_of(p_old -> 'lastRecordedUs'), p_now));
  v_elapsed bigint[];
  v_block   boolean;
  v_want    jsonb;
  v_steps   jsonb;
begin
  if jsonb_typeof(v_src) is distinct from 'object' or jsonb_typeof(v_frames) is distinct from 'array' then
    return 'its source is malformed';
  end if;
  v_rc := recipe.time_constraint_of(p_content, v_cons);
  if v_rc is null then
    return format('it names no time constraint of the batch''s MBR (%s)', coalesce(v_cons, 'none'));
  end if;
  v_limit := recipe.duration_us(v_rc -> case when v_max then 'max' else 'min' end);
  if v_limit is null then
    return format('time constraint %s has no %s', v_cons, case when v_max then 'maximum' else 'minimum' end);
  end if;
  v_step := recipe.step_node(p_content, v_rc -> 'to' ->> 'node') is not null;
  v_source := jsonb_build_object('frames', v_frames, 'constraint', v_cons)
              || case when v_step then jsonb_build_object('step', v_rc -> 'to' ->> 'node') else '{}'::jsonb end;
  if v_src is distinct from v_source then
    return format('its source is not what time constraint %s ends in (%s)', v_cons, v_rc -> 'to' ->> 'node');
  end if;
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'timeInstances') = 'object' then p_new -> 'timeInstances' else '{}'::jsonb end) t
                  where t.value ->> 'constraint' = v_cons and t.value -> 'frames' = v_frames and t.value ->> v_field = p_key) then
    return format('no instance of time constraint %s records it as its breach', v_cons);
  end if;
  if exists (select 1 from jsonb_each(case when jsonb_typeof(p_old -> 'timeInstances') = 'object' then p_old -> 'timeInstances' else '{}'::jsonb end) t
              where t.value ->> 'constraint' = v_cons and t.value -> 'frames' = v_frames and t.value ? v_field) then
    return format('that instance of time constraint %s already had its breach', v_cons);
  end if;
  v_start0 := recipe.time_start_us(v_ev0, v_rc, v_frames);
  v_start1 := recipe.time_start_us(v_ev1, v_rc, v_frames);
  if v_start1 is null and v_start0 is null then
    return format('time constraint %s has not started in that instance', v_cons);
  end if;
  if v_max then
    -- The engine's sweep (before and after the command's own events): the earliest end of the instance later than
    -- the maximum, or, while the instance has no end event at all, the transaction time (never behind the last time
    -- seen).
    select array_agg(distinct q.e) into v_elapsed
      from (select (select min(t.at - v_start0) from recipe.time_ends(v_ev0, v_rc, v_frames, v_start0) t where t.at - v_start0 > v_limit) as e
             where v_start0 is not null
            union all
            select (select min(t.at - v_start1) from recipe.time_ends(v_ev1, v_rc, v_frames, v_start1) t where t.at - v_start1 > v_limit)
             where v_start1 is not null
            union all
            select v_now - v_start0
             where v_start0 is not null and not exists (select 1 from recipe.time_ends(v_ev0, v_rc, v_frames, v_start0)) and v_now - v_start0 > v_limit
            union all
            select v_now - v_start1
             where v_start1 is not null and not exists (select 1 from recipe.time_ends(v_ev1, v_rc, v_frames, v_start1)) and v_now - v_start1 > v_limit) q
     where q.e is not null;
    if v_elapsed is null then
      return format('the recorded times do not exceed the maximum of time constraint %s', v_cons);
    end if;
  else
    -- A minimum: the automatic end event this row recorded came before the minimum.
    select array_agg(distinct q.e) into v_elapsed
      from (select t.at - v_start0 as e from recipe.time_ends(v_ev1, v_rc, v_frames, null) t
             where not (v_ev0 ? t.key) and v_start0 is not null and t.at - v_start0 < v_limit
            union all
            select t.at - v_start1 from recipe.time_ends(v_ev1, v_rc, v_frames, null) t
             where not (v_ev0 ? t.key) and v_start1 is not null and t.at - v_start1 < v_limit) q;
    if v_elapsed is null then
      return format('no end event of this row came before the minimum of time constraint %s', v_cons);
    end if;
  end if;
  v_block := coalesce(v_rc ->> 'breach' = 'EXCEPTION_AND_BLOCK', false);
  -- The title: the engine's text for one of those elapsed times, nothing else (no free text).
  if not exists (select 1 from unnest(v_elapsed) e
                  where (p_x -> 'title') = to_jsonb(recipe.time_fact_title(v_rc ->> 'name', v_max, v_limit, e, v_block))) then
    return format('its title is not the text the system writes for a breach of time constraint %s (%s)', v_cons,
                  coalesce(recipe.time_fact_title(v_rc ->> 'name', v_max, v_limit, v_elapsed[1], v_block), 'none'));
  end if;
  -- The facts of the record (tx.ts raise with the draft of timing.ts raiseTimeException).
  v_want := jsonb_build_object(
    'id', p_key, 'type', p_x ->> 'type', 'category', 'TIME_LIMIT',
    'controls', case when v_max then '["INV-20", "PR-30", "IN-13"]'::jsonb else '["INV-20", "PR-30"]'::jsonb end,
    'severity', 'ACTION', 'source', v_source, 'raisedAt', jsonb_build_object('$u', v_now::text), 'raisedBy', 'SYSTEM',
    'deviationRequired', true, 'registrationRelevant', false, 'qaOnly', v_block, 'stageSignOffBlocked', false, 'releaseBlocking', true,
    'status', 'OPEN');
  if (p_x - 'raisedSeq' - 'title' - 'block') is distinct from v_want or jsonb_typeof(p_x -> 'raisedSeq') is distinct from 'number' then
    return format('its facts are not those the system gives a breach of time constraint %s (category, controls, severity, flags, time of raising)', v_cons);
  end if;
  if not v_block then
    if p_x ? 'block' then
      return format('it stops steps although a breach of time constraint %s does not', v_cons);
    end if;
    return null;
  end if;
  -- The block: until QA's disposition, downstream of the constraint's start, and the unfinished instances of its end
  -- step (as the state stood before or after the command's own events).
  select coalesce(jsonb_agg(s order by s #>> '{}'), '[]'::jsonb) into v_steps
    from jsonb_array_elements(case when jsonb_typeof(p_x -> 'block' -> 'steps') = 'array' then p_x -> 'block' -> 'steps' else '[null]'::jsonb end) s;
  if jsonb_typeof(p_x -> 'block') is distinct from 'object'
     or ((p_x -> 'block') - 'steps' - 'until' - 'downstream') is distinct from '{}'::jsonb
     or (p_x -> 'block' -> 'until') is distinct from '"DISPOSITION"'::jsonb
     or (p_x -> 'block' -> 'downstream') is distinct from jsonb_build_object('node', recipe.flow_anchor(p_content, v_rc -> 'from' ->> 'node'), 'frames', v_frames)
     or (v_steps is distinct from recipe.time_blocked_steps(p_old -> 'steps', case when v_step then v_rc -> 'to' ->> 'node' end, v_frames)
         and v_steps is distinct from recipe.time_blocked_steps(p_new -> 'steps', case when v_step then v_rc -> 'to' ->> 'node' end, v_frames)) then
    return format('its block is not the one a breach of time constraint %s sets (until QA''s disposition, downstream of %s, the unfinished instances of %s)',
                  v_cons, coalesce(recipe.flow_anchor(p_content, v_rc -> 'from' ->> 'node'), 'no node'), coalesce(v_rc -> 'to' ->> 'node', 'none'));
  end if;
  return null;
end
$$;

-- DI-27: the record the engine writes for a regression of the trusted clock noticed at a row whose state saw p_last
-- before (engine.ts openTx), without its sequence number.
create function recipe.clock_regression_record(p_key text, p_last bigint) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'id', p_key, 'type', 'CLOCK_REGRESSION', 'category', 'TIME_SYNC',
    'title', 'The trusted clock went backwards; maximum durations are measured against the latest time seen and minimum durations against the clock as given',
    'controls', '["DI-27"]'::jsonb, 'severity', 'ALERT', 'source', '{"frames": []}'::jsonb, 'raisedAt', jsonb_build_object('$u', p_last::text),
    'raisedBy', 'SYSTEM', 'deviationRequired', false, 'registrationRelevant', false, 'qaOnly', false, 'stageSignOffBlocked', false,
    'releaseBlocking', false, 'status', 'OPEN')
$$;

-- DI-27, INV-20: why node event p_ev (added by row p_row, which moved the state from p_old, NULL at issue, to p_new)
-- is not recorded by that row's own act (header item 2); NULL when it is. p_content is the batch's MBR content.
create function recipe.node_event_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_row recipe.execution_command, p_ev jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_node  text := p_ev ->> 'node';
  v_event text := p_ev ->> 'event';
  v_ctx   text := recipe.ctx_key(p_ev -> 'frames');
  v_step  jsonb := recipe.step_node(p_content, p_ev ->> 'node');
  v_act   boolean := p_row.kind = 'COMMAND' and p_row.accepted is true;
  v_own   boolean := p_row.command ->> 'step' = v_node and recipe.ctx_key(p_row.command -> 'context') = v_ctx;
  v_key   text := v_node || '@' || v_ctx;
begin
  if v_step is null then
    if p_row.kind = 'ISSUE' or v_act then
      return null;
    end if;
    return format('the %s of %s is recorded only by the token advance of an accepted command or of the issue, not by this %s row', v_event, v_node, p_row.kind);
  end if;
  if v_step ->> 'kind' = 'phase' then
    if coalesce(v_act and v_own and p_row.command ->> 'type' = case v_event when 'START' then 'START_STEP' else 'SIGN_PERFORMED' end, false) then
      return null;
    end if;
    return format('the %s of phase %s is recorded only by its own accepted %s', v_event, v_key, case v_event when 'START' then 'START_STEP' else 'SIGN_PERFORMED' end);
  end if;
  if v_event = 'START' then
    if coalesce(p_new -> 'steps' -> v_key ->> 'kind' = 'HOLD' and not coalesce((p_old -> 'steps') ? v_key, false), false) then
      return null;
    end if;
    return format('the START of hold point %s is recorded only by the row that creates the hold point', v_key);
  end if;
  if coalesce(v_act and v_own and p_row.command ->> 'type' = 'DISPOSITION_HOLD_POINT', false) then
    return null;
  end if;
  return format('the END of hold point %s is recorded only by its own accepted DISPOSITION_HOLD_POINT', v_key);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The check of every row's state (header items 1 to 5): the time bookkeeping first, then every new exception
-- ---------------------------------------------------------------------------------------------

-- DI-14, DI-27, INV-03, INV-20: the time bookkeeping a row's state records is the database's own (items 1 to 4), and
-- every exception the row adds is told by its own event, attributed as the row's act implies and, when the system
-- raised it, the finding the engine makes there (0280, item 5). Runs after the projection is written (recipe.write_row
-- writes the row and its events first); the row that produced the state is the one it names (last_seq).
create or replace function recipe.execution_system_fact_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := case when tg_op = 'UPDATE' then old.state end;
  e0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'exceptions', '{}'::jsonb) else '{}'::jsonb end;
  e1        jsonb := new.state -> 'exceptions';
  n0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'nodeEvents', '{}'::jsonb) else '{}'::jsonb end;
  n1        jsonb := new.state -> 'nodeEvents';
  t0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'timeInstances', '{}'::jsonb) else '{}'::jsonb end;
  t1        jsonb := new.state -> 'timeInstances';
  st0       jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'steps', '{}'::jsonb) else '{}'::jsonb end;
  st1       jsonb := new.state -> 'steps';
  r         recipe.execution_command;
  k         text;
  f         text;
  x         jsonb;
  w         jsonb;
  v_raised  jsonb;
  v_content jsonb;
  v_loaded  boolean := false;
  v_problem text;
  v_clock   integer := 0;
  v_last0   bigint;
  v_last1   bigint;
  v_at      bigint;
begin
  if jsonb_typeof(e0) is distinct from 'object' or jsonb_typeof(e1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  if jsonb_typeof(n0) is distinct from 'object' or jsonb_typeof(n1) is distinct from 'object' or jsonb_typeof(t0) is distinct from 'object'
     or jsonb_typeof(t1) is distinct from 'object' or jsonb_typeof(st0) is distinct from 'object' or jsonb_typeof(st1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The steps, node events or time-constraint instances of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.seq is null then
    raise exception using errcode = 'P0001', message = format('The state of batch %s names row %s, which does not exist (DI-34). [EBMR-EXE-030]', new.batch_id, new.last_seq);
  end if;

  -- 1. The last time seen: the later of the previous one and the row's trusted database time.
  v_last0 := recipe.micros_of(s0 -> 'lastRecordedUs');
  v_last1 := recipe.micros_of(new.state -> 'lastRecordedUs');
  if v_last1 is distinct from greatest(r.now_us, coalesce(v_last0, r.now_us)) then
    raise exception using errcode = 'P0001',
      message = format('The state of row %s records %s as the last time seen, not the later of the previous one (%s) and the row''s trusted database time (%s): the time bookkeeping comes from the database clock (DI-27, INV-16). [EBMR-EXE-025]',
                       r.seq, coalesce(v_last1::text, 'none'), coalesce(v_last0::text, 'none'), r.now_us);
  end if;

  -- 2. Node events: never changed or removed; a new one well formed, at the row's time, and recorded by the row's act.
  for k, x in select key, value from jsonb_each(n0) loop
    if (n1 -> k) is distinct from x then
      raise exception using errcode = 'P0001',
        message = format('Row %s changes or removes node event %s; a recorded start or end is kept as recorded (DI-27, INV-20). [EBMR-EXE-026]', r.seq, k);
    end if;
  end loop;
  for k, x in select key, value from jsonb_each(n1) where not (n0 ? key) order by key loop
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x -> 'node') is distinct from 'string' or coalesce(x ->> 'event', '') not in ('START', 'END')
       or jsonb_typeof(x -> 'frames') is distinct from 'array' or recipe.micros_of(x -> 'at') is null
       or (x - 'node' - 'event' - 'frames' - 'at') is distinct from '{}'::jsonb
       or exists (select 1 from jsonb_array_elements(x -> 'frames') g
                   where jsonb_typeof(g -> 'construct') is distinct from 'string' or jsonb_typeof(g -> 'index') is distinct from 'number')
       or k is distinct from (x ->> 'node') || '|' || (x ->> 'event') || '|' || recipe.ctx_key(x -> 'frames') then
      raise exception using errcode = 'P0001',
        message = format('Node event %s of row %s is malformed: a start or end names its node, event, frames and time, under the key of those (DI-34, INV-20). [EBMR-EXE-026]', k, r.seq);
    end if;
    v_at := recipe.micros_of(x -> 'at');
    if v_at is distinct from r.now_us then
      raise exception using errcode = 'P0001',
        message = format('Node event %s of row %s is recorded at %s, not at the row''s trusted database time %s: a start or end a row records is at the time the database gave it, never earlier or later (DI-27, INV-16, INV-20). [EBMR-EXE-025]',
                         k, r.seq, v_at, r.now_us);
    end if;
    if not v_loaded then
      select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
      v_loaded := true;
    end if;
    v_problem := recipe.node_event_problem(v_content, s0, new.state, r, x);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Row %s adds node event %s that its act does not record: %s (DI-27, INV-20, DI-34). [EBMR-EXE-026]', r.seq, k, v_problem);
    end if;
  end loop;

  -- 3. Constraint instances: kept as recorded; a breach mark names the exception this row raises for it.
  for k, x in select key, value from jsonb_each(t0) loop
    w := t1 -> k;
    if jsonb_typeof(w) is distinct from 'object' or (w -> 'key') is distinct from (x -> 'key') or (w -> 'constraint') is distinct from (x -> 'constraint')
       or (w -> 'frames') is distinct from (x -> 'frames')
       or (x ? 'maxBreachException' and (w -> 'maxBreachException') is distinct from (x -> 'maxBreachException'))
       or (x ? 'minBreachException' and (w -> 'minBreachException') is distinct from (x -> 'minBreachException'))
       or ((x -> 'warned') = 'true'::jsonb and (w -> 'warned') is distinct from 'true'::jsonb)
       or ((x -> 'voided') = 'true'::jsonb and (w -> 'voided') is distinct from 'true'::jsonb) then
      raise exception using errcode = 'P0001',
        message = format('Row %s changes or removes the instance %s of a time constraint, its breach, warning or void; they are kept as recorded (DI-27, INV-20). [EBMR-EXE-026]', r.seq, k);
    end if;
  end loop;
  for k, w in select key, value from jsonb_each(t1) order by key loop
    if not (t0 ? k) and (jsonb_typeof(w) is distinct from 'object' or jsonb_typeof(w -> 'constraint') is distinct from 'string'
                         or jsonb_typeof(w -> 'frames') is distinct from 'array' or (w ->> 'key') is distinct from k
                         or k is distinct from (w ->> 'constraint') || '@' || recipe.ctx_key(w -> 'frames')) then
      raise exception using errcode = 'P0001',
        message = format('The instance %s of a time constraint that row %s adds is malformed: it names its constraint and frames under the key of those (DI-34, INV-20). [EBMR-EXE-026]', k, r.seq);
    end if;
    foreach f in array array['maxBreachException', 'minBreachException'] loop
      if w ? f and not coalesce((t0 -> k) ? f, false) then
        x := case when jsonb_typeof(w -> f) = 'string' and not (e0 ? (w ->> f)) then e1 -> (w ->> f) end;
        if not coalesce(jsonb_typeof(x) = 'object'
                        and x ->> 'type' = case f when 'maxBreachException' then 'TIME_MAX_BREACH' else 'TIME_MIN_BREACH' end
                        and (x -> 'source' -> 'constraint') = (w -> 'constraint') and (x -> 'source' -> 'frames') = (w -> 'frames'), false) then
          raise exception using errcode = 'P0001',
            message = format('Row %s marks instance %s of a time constraint as breached (%s) without raising that breach; a breach mark names the exception its row raises (INV-20, DI-26). [EBMR-EXE-026]',
                             r.seq, k, coalesce(w ->> f, 'none'));
        end if;
      end if;
    end loop;
  end loop;

  -- 4. Every step instance the row adds is told by its STEP_STATUS_CHANGED event from PENDING.
  for k in select key from jsonb_each(st1) where not (st0 ? key) order by key loop
    if not exists (select 1 from recipe.execution_event e
                    where e.batch_id = new.batch_id and e.row_seq = new.last_seq and e.event_type = 'STEP_STATUS_CHANGED'
                      and e.event ->> 'stepKey' = k and e.event ->> 'from' = 'PENDING' and e.event ->> 'by' = 'SYSTEM') then
      raise exception using errcode = 'P0001',
        message = format('Row %s adds step instance %s without its STEP_STATUS_CHANGED event from PENDING; a record and the event that tells of it cannot disagree (DI-26, DI-34). [EBMR-EXE-048]', r.seq, k);
    end if;
  end loop;

  -- 5. Every new exception (0280): its EXCEPTION_RAISED event, its raiser and, for a system fact, the engine's finding.
  if exists (select 1 from recipe.execution_event e where e.batch_id = new.batch_id and e.row_seq = new.last_seq and e.event_type = 'EXCEPTION_RAISED'
               and (jsonb_typeof(e.event -> 'exception') is distinct from 'string' or jsonb_typeof(e.event -> 'exceptionType') is distinct from 'string')) then
    raise exception using errcode = 'P0001', message = format('An EXCEPTION_RAISED event of row %s names no exception or no type (DI-26, DI-34). [EBMR-EXE-047]', r.seq);
  end if;
  select coalesce(jsonb_object_agg(q.id, q.types), '{}'::jsonb) into v_raised
    from (select e.event ->> 'exception' as id, jsonb_agg(e.event ->> 'exceptionType' order by e.idx) as types
            from recipe.execution_event e where e.batch_id = new.batch_id and e.row_seq = new.last_seq and e.event_type = 'EXCEPTION_RAISED'
           group by 1) q;
  for k in select jsonb_object_keys(v_raised) loop
    if e0 ? k or not (e1 ? k) then
      raise exception using errcode = 'P0001',
        message = format('Row %s tells that it raised exception %s, which it does not add to the state (DI-26, DI-34). [EBMR-EXE-047]', r.seq, k);
    end if;
  end loop;
  for k, x in select key, value from jsonb_each(e1) where not (e0 ? key) order by key loop
    if jsonb_typeof(x) is distinct from 'object' then
      raise exception using errcode = 'P0001', message = format('Exception %s of the engine state is malformed (DI-34). [EBMR-EXE-030]', k);
    end if;
    if coalesce(v_raised -> k, '[]'::jsonb) is distinct from jsonb_build_array(x -> 'type') then
      raise exception using errcode = 'P0001',
        message = format('Exception %s (%s) is not told by exactly one EXCEPTION_RAISED event of its type in row %s (events: %s) (DI-26, DI-34). [EBMR-EXE-047]',
                         k, coalesce(x ->> 'type', 'no type'), r.seq, coalesce(v_raised -> k, '[]'::jsonb));
    end if;
    if recipe.is_system_fact(x ->> 'type') then
      if x ->> 'raisedBy' is distinct from 'SYSTEM' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s (%s) is a finding of the system about time; it is raised by SYSTEM, not by %s, whose %s row only noticed it (DI-14, INV-03, INV-20). [EBMR-EXE-045]',
                           k, x ->> 'type', coalesce(x ->> 'raisedBy', 'nobody'), r.kind);
      end if;
    elsif r.kind = 'SWEEP' then
      raise exception using errcode = 'P0001',
        message = format('A time sweep records time findings only; exception %s (%s) is not one (INV-20, DI-14). [EBMR-EXE-045]', k, coalesce(x ->> 'type', 'no type'));
    elsif x ->> 'raisedBy' is distinct from r.actor_person::text then
      raise exception using errcode = 'P0001',
        message = format('Exception %s (%s) comes from the act of this %s row, so its raiser is the row''s person %s, not %s (DI-14, INV-03). [EBMR-EXE-045]',
                         k, coalesce(x ->> 'type', 'no type'), r.kind, coalesce(r.actor_person::text, 'unknown'), coalesce(x ->> 'raisedBy', 'nobody'));
    end if;
    if recipe.is_system_fact(x ->> 'type') then
      if x ->> 'type' = 'CLOCK_REGRESSION' then
        v_clock := v_clock + 1;
        v_problem := case
          when v_clock > 1 then 'a row notices the regression of the clock once'
          when (x -> 'source') is distinct from jsonb_build_object('frames', '[]'::jsonb) then 'it does not concern the whole batch'
          when v_last0 is null or r.now_us >= v_last0 then format('the trusted time of the row (%s) is not earlier than the last time seen (%s)', r.now_us, coalesce(v_last0::text, 'none'))
          when v_last1 is distinct from v_last0 then 'the state does not keep the last time seen'
          when (x - 'raisedSeq') is distinct from recipe.clock_regression_record(k, v_last0) or jsonb_typeof(x -> 'raisedSeq') is distinct from 'number'
            then 'it is not the record the system writes for a regression of the clock (title, facts, time of raising)'
        end;
      else
        if not v_loaded then
          select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
          v_loaded := true;
        end if;
        v_problem := recipe.time_fact_problem(v_content, s0, new.state, r.now_us, k, x);
      end if;
      if v_problem is not null then
        raise exception using errcode = 'P0001',
          message = format('Exception %s (%s) raised by SYSTEM in this %s row is not a finding the system can have made there: %s (INV-20, DI-27, DI-14, INV-03). [EBMR-EXE-046]',
                           k, x ->> 'type', r.kind, v_problem);
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- What the system creates: the first content version (header items 6 to 8)
-- ---------------------------------------------------------------------------------------------

-- The identity the database records the system's own creations under, inside a person's command p_ctx: no person,
-- account or session (the nil ids, as for the software-release identity), the role code EXECUTION_ENGINE, which is no
-- role of the catalogue (iam.role) and so is held by no account (like SOFTWARE_RELEASE), source SYSTEM, with the
-- command's correlation id and site zone, so the audit entry sits with the command that made the system act.
-- Installed only by recipe.insert_contents, through kernel.set_actor_context; the identity module never validates it
-- (no command_log entry), so nothing that needs a validated actor runs while it is installed.
create or replace function recipe.system_actor(p_ctx jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
    'role_code', 'EXECUTION_ENGINE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
    'site_zone', p_ctx ->> 'site_zone', 'correlation_id', p_ctx ->> 'correlation_id',
    'legal_name', 'SYSTEM (execution engine)')
$$;

-- The frames of the engine's signing content ([{construct, index}]; signing-content.ts frames).
create function recipe.content_frames(p jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('construct', f -> 'construct', 'index', f -> 'index') order by n), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality as a (f, n)
$$;

-- The signing content the engine derives for exception p_x of state p_state, raised with no recorded value and no
-- deviation (signing-content.ts exceptionSigningContent and exceptionFacts), p_mbr being the batch's MBR content.
create function recipe.exception_content_of(p_mbr jsonb, p_state jsonb, p_x jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object(
    'schema', 'ebmr.batch-exception-content',
    'batch', jsonb_build_object('batchNumber', p_state -> 'header' -> 'batchNumber', 'batchId', p_state -> 'header' -> 'batchId', 'mbrHash', p_state -> 'mbrHash',
                                'family', p_mbr -> 'header' -> 'family', 'product', p_mbr -> 'header' -> 'product' -> 'code'),
    'exception', jsonb_build_object(
      'id', p_x -> 'id', 'type', p_x -> 'type', 'category', p_x -> 'category', 'title', p_x -> 'title', 'controls', p_x -> 'controls',
      'severity', p_x -> 'severity', 'tier', coalesce(p_x -> 'tier', 'null'::jsonb), 'requirement', coalesce(p_x -> 'requirement', 'null'::jsonb),
      'source', jsonb_build_object(
        'stepKey', coalesce(p_x -> 'source' -> 'stepKey', 'null'::jsonb), 'step', coalesce(p_x -> 'source' -> 'step', 'null'::jsonb),
        'frames', recipe.content_frames(p_x -> 'source' -> 'frames'), 'item', coalesce(p_x -> 'source' -> 'item', 'null'::jsonb),
        'point', coalesce(p_x -> 'source' -> 'point', 'null'::jsonb), 'derived', coalesce(p_x -> 'source' -> 'derived', 'null'::jsonb),
        'constraint', coalesce(p_x -> 'source' -> 'constraint', 'null'::jsonb), 'construct', coalesce(p_x -> 'source' -> 'construct', 'null'::jsonb)),
      'raisedAt', to_jsonb(recipe.micros_of(p_x -> 'raisedAt')::text), 'raisedBy', p_x -> 'raisedBy',
      'blocks', case when jsonb_typeof(p_x -> 'block') = 'object'
                     then jsonb_build_object('steps', p_x -> 'block' -> 'steps',
                                             'downstream', case when jsonb_typeof(p_x -> 'block' -> 'downstream') = 'object'
                                                                then jsonb_build_object('node', p_x -> 'block' -> 'downstream' -> 'node',
                                                                                        'frames', recipe.content_frames(p_x -> 'block' -> 'downstream' -> 'frames'))
                                                                else 'null'::jsonb end,
                                             'until', p_x -> 'block' -> 'until')
                     else 'null'::jsonb end,
      'deviationRequired', p_x -> 'deviationRequired', 'registrationRelevant', p_x -> 'registrationRelevant', 'qaOnly', p_x -> 'qaOnly',
      'stageSignOffBlocked', p_x -> 'stageSignOffBlocked', 'releaseBlocking', p_x -> 'releaseBlocking'),
    'recorded', 'null'::jsonb,
    'deviation', 'null'::jsonb)
$$;

-- Whether content p_c ({type, key, content}) is the first version of a record the system created in row p_seq of
-- batch p_batch, whose resulting state is p_state, with nobody's entry in it (0280, header item 7):
--   * an exception raised by SYSTEM (a time fact, checked in full by recipe.execution_system_fact_check when the state
--     was written), told by this row's EXCEPTION_RAISED event, open and unlinked, whose stored content is exactly the
--     content the engine derives from it (recipe.exception_content_of);
--   * a hold point that this row's token advance enabled or set not applicable (its STEP_STATUS_CHANGED event from
--     PENDING, by SYSTEM), not started, decided or signed, with no performer, enterer, corrector or signer, whose
--     stored content holds no data point, value, entry or exception (as 0280).
create or replace function recipe.created_by_system(p_batch uuid, p_seq bigint, p_state jsonb, p_c jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key text := p_c ->> 'key';
  v_ct  jsonb := p_c -> 'content';
  v_mbr jsonb;
  x     jsonb;
  f     text;
begin
  if jsonb_typeof(p_state) is distinct from 'object' or v_key is null or jsonb_typeof(v_ct) is distinct from 'object' then
    return false;
  end if;
  if p_c ->> 'type' = 'batch_exception' then
    x := p_state -> 'exceptions' -> v_key;
    if not coalesce(jsonb_typeof(x) = 'object' and x ->> 'raisedBy' = 'SYSTEM' and recipe.is_system_fact(x ->> 'type') and x ->> 'status' = 'OPEN'
                    and not (x ?| array['deviation', 'disposition']), false) then
      return false;
    end if;
    select pk.content into v_mbr from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
    return coalesce(
      exists (select 1 from recipe.execution_event e
               where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'EXCEPTION_RAISED'
                 and e.event ->> 'exception' = v_key and e.event ->> 'exceptionType' = x ->> 'type')
      and v_ct = recipe.exception_content_of(v_mbr, p_state, x),
      false);
  end if;
  if p_c ->> 'type' = 'batch_step' then
    x := p_state -> 'steps' -> v_key;
    if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' or coalesce(x ->> 'status', '') not in ('ENABLED', 'NOT_APPLICABLE')
       or x ?| array['disposition', 'startedAt', 'endedAt'] then
      return false;
    end if;
    foreach f in array array['performers', 'dataEnterers', 'correctors', 'performedSigners', 'signatures'] loop
      if coalesce(x -> f, '[]'::jsonb) is distinct from '[]'::jsonb then
        return false;
      end if;
    end loop;
    foreach f in array array['points', 'derived', 'entries', 'exceptions'] loop
      if v_ct -> f is distinct from '[]'::jsonb then
        return false;
      end if;
    end loop;
    return coalesce(
      v_ct -> 'step' ->> 'key' = v_key and v_ct -> 'step' ->> 'kind' = 'HOLD'
      and exists (select 1 from recipe.execution_event e
                   where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'STEP_STATUS_CHANGED'
                     and e.event ->> 'stepKey' = v_key and e.event ->> 'from' = 'PENDING' and e.event ->> 'by' = 'SYSTEM'),
      false);
  end if;
  return false;
end
$$;

-- Inserts a new version for every aggregate whose content hash changed ([{type, key, content, contentHash}]); the
-- e-signature triggers supersede the signatures made on the previous version (as 0210). The first version of a
-- record the system created in a person's row with nobody's entry in it (recipe.created_by_system) is inserted as
-- the system's (recipe.system_actor, installed with kernel.set_actor_context), and the command's own validated
-- context is re-installed right after it (0280). Every entry is an object naming a known aggregate type, a key and a
-- content object (NULL-safe, EBMR-EXE-055). Then every exception the row raises and every hold point it creates has
-- its first content version stored by this row (EBMR-EXE-057).
create or replace function recipe.insert_contents(p_batch uuid, p_seq bigint, p_contents jsonb) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c       jsonb;
  v_table regclass;
  v_agg   text;
  v_hash  text;
  v_last  record;
  n       integer := 0;
  v_state jsonb;
  v_ctx   jsonb;
  v_miss  text;
begin
  if jsonb_typeof(coalesce(p_contents, '[]'::jsonb)) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'The signable content of the command is malformed (DI-37). [EBMR-EXE-055]';
  end if;
  -- The state this row produced: the projection the writer has just written for it.
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch and s.last_seq = p_seq;
  if jsonb_typeof(v_state) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = format('The state of batch %s is not the one row %s produced (DI-34). [EBMR-EXE-030]', p_batch, p_seq);
  end if;
  for c in select * from jsonb_array_elements(coalesce(p_contents, '[]'::jsonb)) loop
    v_table := recipe.content_table(c ->> 'type');
    if v_table is null or coalesce(c ->> 'key', '') = '' or jsonb_typeof(c -> 'content') is distinct from 'object' then
      raise exception using errcode = 'P0001', message = format('Unknown signable aggregate %s (DI-37). [EBMR-EXE-055]', coalesce(c ->> 'type', 'none'));
    end if;
    v_agg := p_batch::text || ':' || (c ->> 'key');
    v_hash := recipe.canonical_hash(c -> 'content');
    if v_hash is distinct from c ->> 'contentHash' then
      raise exception using errcode = 'P0001',
        message = format('The content of %s:%s does not hash to %s (DI-37). [EBMR-EXE-056]', c ->> 'type', v_agg, coalesce(c ->> 'contentHash', 'none'));
    end if;
    execute format('select content_version, content_hash from %s where aggregate_id = $1 order by content_version desc limit 1', v_table)
      into v_last using v_agg;
    if v_last.content_hash is not distinct from v_hash then
      continue;
    end if;
    -- A row of the system itself (a SWEEP, source SYSTEM) stores it under its own identity.
    v_ctx := null;
    if v_last.content_version is null and recipe.created_by_system(p_batch, p_seq, v_state, c) then
      v_ctx := kernel.current_actor();
      if coalesce(v_ctx ->> 'source', 'SYSTEM') = 'SYSTEM' then
        v_ctx := null;
      end if;
    end if;
    if v_ctx is not null then
      perform kernel.set_actor_context(recipe.system_actor(v_ctx));
    end if;
    execute format('insert into %s (batch_id, aggregate_key, aggregate_id, content_version, content, content_hash, row_seq) values ($1, $2, $3, $4, $5, $6, $7)', v_table)
      using p_batch, c ->> 'key', v_agg, coalesce(v_last.content_version, 0) + 1, c -> 'content', v_hash, p_seq;
    if v_ctx is not null then
      perform kernel.set_actor_context(v_ctx);
    end if;
    n := n + 1;
  end loop;
  -- Completeness: what the row raised or created is stored by the row itself.
  select e.event ->> 'exception' into v_miss
    from recipe.execution_event e
   where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'EXCEPTION_RAISED'
     and not exists (select 1 from recipe.execution_exception_content x
                      where x.aggregate_id = p_batch::text || ':' || (e.event ->> 'exception') and x.row_seq = p_seq)
   order by e.idx limit 1;
  if v_miss is null then
    select e.event ->> 'stepKey' into v_miss
      from recipe.execution_event e
     where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'STEP_STATUS_CHANGED' and e.event ->> 'from' = 'PENDING'
       and v_state -> 'steps' -> (e.event ->> 'stepKey') ->> 'kind' = 'HOLD'
       and not exists (select 1 from recipe.execution_step_content x
                        where x.aggregate_id = p_batch::text || ':' || (e.event ->> 'stepKey') and x.row_seq = p_seq)
     order by e.idx limit 1;
  end if;
  if v_miss is not null then
    raise exception using errcode = 'P0001',
      message = format('Row %s raises or creates %s without storing its first content version: an exception or hold point is stored by the row that brings it into the record, under that row''s attribution (DI-37, INV-03, DI-14). [EBMR-EXE-057]',
                       p_seq, v_miss);
  end if;
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: every new helper is private to the owner (the trigger and the writers run them). CREATE OR REPLACE
-- kept the privileges of the replaced functions (0210, 0280: owner only).
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.format_micros(bigint), recipe.time_fact_title(text, boolean, bigint, bigint, boolean), recipe.flow_anchor(jsonb, text),
                       recipe.time_blocked_steps(jsonb, text, jsonb), recipe.clock_regression_record(text, bigint),
                       recipe.node_event_problem(jsonb, jsonb, jsonb, recipe.execution_command, jsonb), recipe.content_frames(jsonb),
                       recipe.exception_content_of(jsonb, jsonb, jsonb)
  from public;

reset role;
