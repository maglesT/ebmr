-- Recipe core, execution store (module C3): what the system finds, or creates, inside a person's call is recorded as
-- the system's act, never as the act of the person whose call happened to trigger it (review findings P35 and P28;
-- DI-14, INV-03, INV-20, DI-27; ADR 0012: the rules hold when the application's own credentials are used directly).
--
-- Before this release:
--   * the engine evaluates every time limit at every command, at every signing preparation (PREPARE) and in the
--     time sweep (INV-20). A breach found inside a person's command or PREPARE, and a regression of the trusted
--     clock, were raised in that person's name (raisedBy), while the same breach found first by the sweeper was
--     raised by SYSTEM;
--   * the first content version of every record the engine creates inside a row (a breach, a hold point the token
--     advance enables) is stored by that row, in the person's transaction, so the e-signature module logged the
--     person as having changed a record they never touched (esig.content_change, kernel 0220), and the batch_exception
--     content provider (0210, 0295) listed a person raiser among those who entered the exception.
-- EXCEPTION_DISPOSITIONED and HOLD_POINT_RELEASED exclude such persons (INV-03), so the one QA reviewer whose
-- challenge noticed a QA-only breach, or whose release of a hold point enabled the next one, was barred from
-- deciding it (EBMR-ESIG-044), while the screens offered it to them.
--
-- The engine now raises every time fact as SYSTEM (recipe-core engine, `asSystem`). This migration:
--
--   1. Refuses a new exception attributed otherwise than the row's act implies (EBMR-EXE-045): a time fact
--      (recipe.is_system_fact: a maximum or minimum time breach, a clock regression) is raised by SYSTEM in every
--      kind of row; a time sweep (SWEEP row) adds time facts only; any other exception is raised by the row's own
--      person (the validated actor the row records, recipe.execution_command.actor_person).
--   2. Refuses a new exception without its own EXCEPTION_RAISED event of the same type in the row, and an
--      EXCEPTION_RAISED event of the row for an exception the row does not add (EBMR-EXE-047). The events are part
--      of the hash-chained row; a record and the event that tells of it cannot disagree.
--   3. Refuses a time fact the batch's MBR, its time bookkeeping and the row's trusted time do not support
--      (EBMR-EXE-046). Rule 1 alone lets a writer relabel the person's own exception as a time fact raised by
--      SYSTEM, which would drop the person from those who entered it (review of the first fix). So:
--        * a time breach names a time constraint of the batch's pinned MBR content (its own list, or the implicit
--          hold time of an intermediate or maximum duration of a loop, as the engine derives them) that has the
--          limit breached; it names the constraint's end step exactly when that end is a step, and nothing else;
--        * the constraint instance of the new state records exactly this exception as its breach of that kind, and
--          the instance of the previous state had none (one breach per instance and kind);
--        * the recorded times show it: for a maximum, an end event of the instance later than the maximum, or, while
--          no end event was recorded before this row, the row's trusted time (never earlier than the last time
--          seen) past the maximum; for a minimum, an end event this row recorded before the minimum;
--        * a clock regression concerns the whole batch, the row's trusted time is earlier than the last time the
--          previous state saw, the new state keeps that last time, and a row notices it once.
--   4. Records the first content version of a record the system created in a person's row, with nobody's entry in
--      it, as the system's creation (recipe.insert_contents): a time fact validated by 2 and 3, and a hold point the
--      token advance of this row enabled (or set not applicable) that no one has worked on. The version is inserted
--      under the system's own identity, installed with kernel.set_actor_context (the kernel's way for module code
--      to act as an internal actor inside a command; nil person, account and session, role EXECUTION_SWEEPER, source
--      SYSTEM, the command's correlation id), and the command's own validated context is restored at once. So the
--      audit trail and the e-signature change log name the system for that version; every later version, and every
--      version whose stored content or state holds any entry of a person or does not match the state, stays the
--      change of the row's person. A SWEEP row stores what it finds under the sweeper's own identity, as before.
--      The row itself (COMMAND, PREPARE, ISSUE) stays the person's own act, in their name.
--
-- The checks work on the facts the state records; the database does not re-run the engine. A state forged
-- throughout (invented node events, a free-text title of a breach) is caught by the replay verification (ADR 0010),
-- not here. Exceptions the token advance raises from the MBR's flow (DECISION_NOT_EVALUABLE, REPLICATE_COUNT_INVALID,
-- LOOP_EXHAUSTED, a limit verdict at a loop exit) stay raised by the person whose command ran the advance: the
-- database cannot confirm them as it confirms a time fact, and a SYSTEM label that cannot be confirmed would let a
-- person move their own exception out of INV-03. The stricter attribution is kept. A stage frame's first version
-- stays the person's too (no meaning on a stage excludes performers). Exceptions already in the stored state are
-- never re-judged (0270 keeps them exactly as raised).
--
-- Messages: EBMR-EXE-045 (attribution), EBMR-EXE-046 (a time fact the records do not support), EBMR-EXE-047 (an
-- exception and its event disagree). recipe.insert_contents is replaced with its owner, SECURITY DEFINER, search_path
-- and privileges kept; every new helper is private to the owner. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- What the system finds about time
-- ---------------------------------------------------------------------------------------------

-- The exception types the engine raises as the system's own finding, whoever's call evaluated the time (the
-- engine's time facts: exceptions.ts ENGINE_EXCEPTION_RULES, timing.ts, engine.ts openTx). A release that adds a
-- system fact replaces this function and adds its check to recipe.execution_system_fact_check.
create function recipe.is_system_fact(p_type text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_type in ('TIME_MAX_BREACH', 'TIME_MIN_BREACH', 'CLOCK_REGRESSION'), false)
$$;

-- A duration of the MBR ({value, unit}) in microseconds, as the engine reads it (flow/decimal.ts durationToMicros):
-- NULL when the unit is not a time unit or the value is not a whole number of microseconds.
create function recipe.duration_us(p_q jsonb) returns bigint
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_factor bigint;
  v_us     numeric;
begin
  if jsonb_typeof(p_q) is distinct from 'object' or jsonb_typeof(p_q -> 'value') is distinct from 'string'
     or (p_q ->> 'value') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' or (p_q ->> 'value') ~ '^-0(\.0+)?$' then
    return null;
  end if;
  v_factor := case p_q ->> 'unit' when 'ms' then 1000 when 's' then 1000000 when 'min' then 60000000
                                  when 'h' then 3600000000 when 'd' then 86400000000 end;
  if v_factor is null then
    return null;
  end if;
  v_us := (p_q ->> 'value')::numeric * v_factor;
  if v_us <> trunc(v_us) or abs(v_us) > 9223372036854775807 then
    return null;
  end if;
  return v_us::bigint;
end
$$;

-- The node p_id of kind p_kind in MBR content p_content, as the engine expands it (recipe.step_node, 0270, for any
-- kind): a node inlined from a library element has the id <call>/<inner id>. NULL when no node, or more than one,
-- answers (fail closed).
create function recipe.flow_node_of(p_content jsonb, p_id text, p_kind text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_parts text[] := string_to_array(p_id, '/');
  v_scope jsonb := p_content -> 'procedure';
  v_node  jsonb;
  v_n     bigint;
  v_els   jsonb := case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end;
begin
  if coalesce(array_length(v_parts, 1), 0) = 0 or jsonb_typeof(v_scope) is distinct from 'object' then
    return null;
  end if;
  for i in 1 .. array_length(v_parts, 1) loop
    select count(*), (array_agg(n))[1] into v_n, v_node
      from jsonb_path_query(v_scope, 'strict $.** ? (@.id == $id && (@.kind == $kind || @.kind == "libraryCall"))',
                            jsonb_build_object('id', v_parts[i], 'kind', p_kind)) n;
    if v_n is distinct from 1 then
      return null;
    end if;
    if i < array_length(v_parts, 1) then
      if v_node ->> 'kind' is distinct from 'libraryCall' then
        return null;
      end if;
      select count(*), (array_agg(e -> 'body'))[1] into v_n, v_scope from jsonb_array_elements(v_els) e where e ->> 'ref' = v_node ->> 'element';
      if v_n is distinct from 1 or jsonb_typeof(v_scope) is distinct from 'object' then
        return null;
      end if;
    end if;
  end loop;
  if v_node ->> 'kind' is distinct from p_kind then
    return null;
  end if;
  return v_node;
end
$$;

-- The runtime time constraint p_id of MBR content p_content as the engine derives it (engine/definition.ts):
-- {from: {node, event}, to: {node, event}, max?, min?}. The MBR's own list (node events only), the hold time of an
-- intermediate from each phase producing it to each phase using it (HOLD-TIME:<intermediate>:<producer>><user>),
-- and the maximum duration of a loop (LOOP-MAX-DURATION:<loop>). NULL when the MBR has no such constraint.
create function recipe.time_constraint_of(p_content jsonb, p_id text) returns jsonb
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
                              'max', v_tc -> 'holdTime' -> 'max');
  end if;
  if p_id like 'LOOP-MAX-DURATION:%' then
    v_loop := recipe.flow_node_of(p_content, substr(p_id, 19), 'loop');
    if jsonb_typeof(v_loop -> 'maxDuration') is distinct from 'object' then
      return null;
    end if;
    return jsonb_build_object('from', jsonb_build_object('node', substr(p_id, 19), 'event', 'START'), 'to', jsonb_build_object('node', substr(p_id, 19), 'event', 'END'),
                              'max', v_loop -> 'maxDuration');
  end if;
  select count(*), (array_agg(t))[1] into v_n, v_tc
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'timeConstraints') = 'array' then p_content -> 'timeConstraints' else '[]'::jsonb end) t
   where t ->> 'id' = p_id;
  if v_n is distinct from 1 or jsonb_typeof(v_tc -> 'from' -> 'node') is distinct from 'string' or jsonb_typeof(v_tc -> 'to' -> 'node') is distinct from 'string'
     or coalesce(v_tc -> 'from' ->> 'event', '') not in ('START', 'END') or coalesce(v_tc -> 'to' ->> 'event', '') not in ('START', 'END') then
    return null;
  end if;
  return jsonb_build_object('from', jsonb_build_object('node', v_tc -> 'from' ->> 'node', 'event', v_tc -> 'from' ->> 'event'),
                            'to', jsonb_build_object('node', v_tc -> 'to' ->> 'node', 'event', v_tc -> 'to' ->> 'event'))
         || jsonb_strip_nulls(jsonb_build_object('max', v_tc -> 'max', 'min', v_tc -> 'min'));
end
$$;

-- The instant (microseconds) the constraint instance with frames p_frames starts in node events p_events: the
-- earliest START or the latest END of its from-node among the events of that instance (timing.ts fromInstant).
-- An event belongs to the instance when its frames hold every frame of the instance (the instance frames are the
-- event's frames of the constructs both ends share, timing.ts within).
create function recipe.time_start_us(p_events jsonb, p_rc jsonb, p_frames jsonb) returns bigint
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when p_rc -> 'from' ->> 'event' = 'START' then min(recipe.micros_of(e.value -> 'at')) else max(recipe.micros_of(e.value -> 'at')) end
    from jsonb_each(case when jsonb_typeof(p_events) = 'object' then p_events else '{}'::jsonb end) e
   where e.value ->> 'node' = p_rc -> 'from' ->> 'node' and e.value ->> 'event' = p_rc -> 'from' ->> 'event'
     and jsonb_typeof(e.value -> 'frames') = 'array' and (e.value -> 'frames') @> p_frames
$$;

-- The end events of the constraint instance with frames p_frames in node events p_events, at or after p_start:
-- {key, at} rows (key: the node-event key of the state).
create function recipe.time_ends(p_events jsonb, p_rc jsonb, p_frames jsonb, p_start bigint) returns table (key text, at bigint)
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select e.key, recipe.micros_of(e.value -> 'at')
    from jsonb_each(case when jsonb_typeof(p_events) = 'object' then p_events else '{}'::jsonb end) e
   where e.value ->> 'node' = p_rc -> 'to' ->> 'node' and e.value ->> 'event' = p_rc -> 'to' ->> 'event'
     and jsonb_typeof(e.value -> 'frames') = 'array' and (e.value -> 'frames') @> p_frames
     and (p_start is null or recipe.micros_of(e.value -> 'at') >= p_start)
$$;

-- INV-20, DI-27: why a new time breach p_x (id p_key) raised by SYSTEM in a row at trusted time p_now, moving the
-- state from p_old (NULL for an issue) to p_new, is not a finding the engine can have made there; NULL when it is.
-- See the header (3) for the rules.
create function recipe.time_fact_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_now bigint, p_key text, p_x jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_max    boolean := p_x ->> 'type' = 'TIME_MAX_BREACH';
  v_src    jsonb := p_x -> 'source';
  v_frames jsonb := p_x -> 'source' -> 'frames';
  v_cons   text := p_x -> 'source' ->> 'constraint';
  v_rc     jsonb;
  v_limit  bigint;
  v_step   boolean;
  v_field  text := case when p_x ->> 'type' = 'TIME_MAX_BREACH' then 'maxBreachException' else 'minBreachException' end;
  v_ev0    jsonb := case when jsonb_typeof(p_old -> 'nodeEvents') = 'object' then p_old -> 'nodeEvents' else '{}'::jsonb end;
  v_ev1    jsonb := case when jsonb_typeof(p_new -> 'nodeEvents') = 'object' then p_new -> 'nodeEvents' else '{}'::jsonb end;
  v_start0 bigint;
  v_start1 bigint;
  v_now    bigint;
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
  if v_src ?| array['stepKey', 'item', 'point', 'derived', 'construct'] or (v_src ? 'step') is distinct from v_step
     or (v_step and v_src ->> 'step' is distinct from v_rc -> 'to' ->> 'node') then
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
    -- Found at an end event, or (no end event recorded before this row) at the transaction time, which never goes
    -- back behind the last time seen (the engine's tx.now), either before or after the row's own events.
    v_now := greatest(p_now, coalesce(recipe.micros_of(p_old -> 'lastRecordedUs'), p_now));
    if exists (select 1 from recipe.time_ends(v_ev1, v_rc, v_frames, v_start1) t where t.at - v_start1 > v_limit)
       or exists (select 1 from recipe.time_ends(v_ev0, v_rc, v_frames, v_start0) t where t.at - v_start0 > v_limit)
       or (v_start0 is not null and not exists (select 1 from recipe.time_ends(v_ev0, v_rc, v_frames, v_start0)) and v_now - v_start0 > v_limit)
       or (v_start1 is not null and not exists (select 1 from recipe.time_ends(v_ev1, v_rc, v_frames, v_start1)) and v_now - v_start1 > v_limit) then
      return null;
    end if;
    return format('the recorded times do not exceed the maximum of time constraint %s', v_cons);
  end if;
  -- A minimum: the automatic end event this row recorded came before the minimum.
  if exists (select 1 from recipe.time_ends(v_ev1, v_rc, v_frames, null) t
              where not (v_ev0 ? t.key) and ((v_start1 is not null and t.at - v_start1 < v_limit) or (v_start0 is not null and t.at - v_start0 < v_limit))) then
    return null;
  end if;
  return format('no end event of this row came before the minimum of time constraint %s', v_cons);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The check of every new exception (header 1 to 3)
-- ---------------------------------------------------------------------------------------------

-- DI-14, INV-03, INV-20, DI-27: every exception a row adds to the state is told by its own event, attributed as the
-- row's act implies and, when the system raised it, supported by the records. Runs after the projection is written
-- (recipe.write_row writes the row and its events first); the row that produced the state is the one it names
-- (last_seq).
create function recipe.execution_system_fact_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := case when tg_op = 'UPDATE' then old.state end;
  e0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'exceptions', '{}'::jsonb) else '{}'::jsonb end;
  e1        jsonb := new.state -> 'exceptions';
  r         recipe.execution_command;
  k         text;
  x         jsonb;
  v_raised  jsonb;
  v_content jsonb;
  v_problem text;
  v_clock   integer := 0;
  v_last0   bigint;
begin
  if jsonb_typeof(e0) is distinct from 'object' or jsonb_typeof(e1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.seq is null then
    raise exception using errcode = 'P0001', message = format('The state of batch %s names row %s, which does not exist (DI-34). [EBMR-EXE-030]', new.batch_id, new.last_seq);
  end if;
  -- The EXCEPTION_RAISED events of the row: each names an exception this row adds.
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
    -- 2. Its own event, of its own type.
    if coalesce(v_raised -> k, '[]'::jsonb) is distinct from jsonb_build_array(x -> 'type') then
      raise exception using errcode = 'P0001',
        message = format('Exception %s (%s) is not told by exactly one EXCEPTION_RAISED event of its type in row %s (events: %s) (DI-26, DI-34). [EBMR-EXE-047]',
                         k, coalesce(x ->> 'type', 'no type'), r.seq, coalesce(v_raised -> k, '[]'::jsonb));
    end if;
    -- 1. Its raiser.
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
    -- 3. A system fact the records support.
    if recipe.is_system_fact(x ->> 'type') then
      if x ->> 'type' = 'CLOCK_REGRESSION' then
        v_clock := v_clock + 1;
        v_last0 := recipe.micros_of(s0 -> 'lastRecordedUs');
        v_problem := case
          when v_clock > 1 then 'a row notices the regression of the clock once'
          when (x -> 'source') is distinct from jsonb_build_object('frames', '[]'::jsonb) then 'it does not concern the whole batch'
          when v_last0 is null or r.now_us >= v_last0 then format('the trusted time of the row (%s) is not earlier than the last time seen (%s)', r.now_us, coalesce(v_last0::text, 'none'))
          when recipe.micros_of(new.state -> 'lastRecordedUs') is distinct from v_last0 then 'the state does not keep the last time seen'
        end;
      else
        if v_content is null then
          select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
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

create trigger zz_execution_system_facts after insert or update on recipe.execution_state
  for each row execute function recipe.execution_system_fact_check();

-- ---------------------------------------------------------------------------------------------
-- What the system creates: the first content version (header 4)
-- ---------------------------------------------------------------------------------------------

-- The identity the database records the system's own creations under, inside a person's command p_ctx: no person,
-- account or session (the nil ids, as for the software-release identity), the role that holds the system's
-- execution permission (EXECUTION_SWEEPER, recipe-core 0260), source SYSTEM, with the command's correlation id and
-- site zone, so the audit entry sits with the command that made the system act. Installed only by
-- recipe.insert_contents, through kernel.set_actor_context; the identity module never validates it (no command_log
-- entry), so nothing that needs a validated actor runs while it is installed.
create function recipe.system_actor(p_ctx jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
    'role_code', 'EXECUTION_SWEEPER', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
    'site_zone', p_ctx ->> 'site_zone', 'correlation_id', p_ctx ->> 'correlation_id',
    'legal_name', 'SYSTEM (execution engine)')
$$;

-- Whether content p_c ({type, key, content}) is the first version of a record the system created in row p_seq of
-- batch p_batch, whose resulting state is p_state, with nobody's entry in it (header 4):
--   * an exception raised by SYSTEM (a time fact, checked by recipe.execution_system_fact_check when the state was
--     written), told by this row's EXCEPTION_RAISED event, open and unlinked, whose stored content is the state's
--     exception as raised, without a recorded value or a deviation;
--   * a hold point that this row's token advance enabled or set not applicable (its STEP_STATUS_CHANGED event from
--     PENDING, by SYSTEM), not started, decided or signed, with no performer, enterer, corrector or signer, whose
--     stored content holds no data point, value, entry or exception.
create function recipe.created_by_system(p_batch uuid, p_seq bigint, p_state jsonb, p_c jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key text := p_c ->> 'key';
  v_ct  jsonb := p_c -> 'content';
  x     jsonb;
  f     text;
begin
  if jsonb_typeof(p_state) is distinct from 'object' or v_key is null or jsonb_typeof(v_ct) is distinct from 'object' then
    return false;
  end if;
  if p_c ->> 'type' = 'batch_exception' then
    x := p_state -> 'exceptions' -> v_key;
    return coalesce(
      jsonb_typeof(x) = 'object' and x ->> 'raisedBy' = 'SYSTEM' and recipe.is_system_fact(x ->> 'type') and x ->> 'status' = 'OPEN'
      and not (x ?| array['deviation', 'disposition'])
      and exists (select 1 from recipe.execution_event e
                   where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'EXCEPTION_RAISED'
                     and e.event ->> 'exception' = v_key and e.event ->> 'exceptionType' = x ->> 'type')
      and v_ct -> 'exception' ->> 'id' = v_key and v_ct -> 'exception' ->> 'type' = x ->> 'type'
      and v_ct -> 'exception' ->> 'title' = x ->> 'title' and v_ct -> 'exception' ->> 'raisedBy' = 'SYSTEM'
      and v_ct -> 'exception' -> 'source' -> 'frames' = x -> 'source' -> 'frames'
      and (v_ct -> 'exception' -> 'source' ->> 'constraint') is not distinct from (x -> 'source' ->> 'constraint')
      and (v_ct -> 'exception' -> 'source' ->> 'step') is not distinct from (x -> 'source' ->> 'step')
      and coalesce(v_ct -> 'recorded', 'null'::jsonb) = 'null'::jsonb and coalesce(v_ct -> 'deviation', 'null'::jsonb) = 'null'::jsonb,
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
-- context is re-installed right after it, the same way (DI-14, INV-03; review P28).
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
begin
  if jsonb_typeof(coalesce(p_contents, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'P0001', message = 'The signable content of the command is malformed (DI-37). [EBMR-EXE-055]';
  end if;
  -- The state this row produced (NULL when the projection is not this row's: then nothing is the system's).
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch and s.last_seq = p_seq;
  for c in select * from jsonb_array_elements(coalesce(p_contents, '[]'::jsonb)) loop
    v_table := recipe.content_table(c ->> 'type');
    if v_table is null or coalesce(c ->> 'key', '') = '' or jsonb_typeof(c -> 'content') <> 'object' then
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
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: every new helper is private to the owner (the trigger and the writers run them). CREATE OR REPLACE
-- kept the privileges of recipe.insert_contents (0210: owner only).
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.is_system_fact(text), recipe.duration_us(jsonb), recipe.flow_node_of(jsonb, text, text),
                       recipe.time_constraint_of(jsonb, text), recipe.time_start_us(jsonb, jsonb, jsonb),
                       recipe.time_ends(jsonb, jsonb, jsonb, bigint), recipe.time_fact_problem(jsonb, jsonb, jsonb, bigint, text, jsonb),
                       recipe.execution_system_fact_check(), recipe.system_actor(jsonb), recipe.created_by_system(uuid, bigint, jsonb, jsonb)
  from public;

reset role;
