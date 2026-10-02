-- Recipe core, execution store (module C3): the step an exception was raised at is read from the row that raised it,
-- not only from the source the writer stores in the exception (Phase 2 exit review F11, round-3 verification; INV-03,
-- PR-13, PR-49, DI-17, DI-35; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
-- 0306 and 0310 read the step an exception was raised at from the stored exception's source.stepKey, and refused a
-- disposition by a person involved in that step. For an exception a block or the engine raises, that source is the
-- writer's: 0298 binds it only for an operator's exception, 0305 only for a limit breach or a yield. The round-3
-- verification stored, through the application role, operator2's CLEARANCE_CHECK on the line clearance with one item
-- not confirmed and the engine's real result, except that the CLEARANCE_FAILED it raised kept no step (source {frames:
-- []}). operator1, who had started the clearance and also held QA_SHOP_FLOOR, then signed and stored its disposition
-- with the engine's own, unmodified result: the provider named only operator2, the database accepted it, and the
-- invariant query reported nothing.
--
-- The row that raised an exception is fixed: every exception a row adds is told by exactly one EXCEPTION_RAISED event of
-- that row (0280, 0299, EBMR-EXE-047), the events are insert-only and hash-chained with their row, and an accepted
-- command row names its person from the validated session. The step that row's command acts on comes from the command
-- itself: the step and context of START_STEP, RECORD_DATA, RECORD_ENTRY, SIGN_PERFORMED, VERIFY, REQUEST_SKIP,
-- DISPOSITION_HOLD_POINT, VOID_ATTEMPT and RAISE_EXCEPTION, and the step of the data point a CORRECT_ENTRY or an
-- INVALIDATE_RESULT names (a point's step is kept as recorded, 0303). This migration:
--
--   1. recipe.command_step_key(type, command, points): that step instance of an accepted command, NULL for a command
--      that acts on no step;
--   2. recipe.exception_raising_steps(batch, state, exception): the steps the exception was raised at, the union of
--      the stored source.stepKey and the step the command of each row whose EXCEPTION_RAISED event names the exception
--      acts on. A finding of the system about time (TIME_MAX_BREACH, TIME_MIN_BREACH, CLOCK_REGRESSION) is raised by
--      SYSTEM, not by the act of the row that noticed it, and its source is bound by 0299 (recipe.time_fact_problem):
--      only its stored source counts, as in the engine. Where the engine raises an exception at another step than the
--      one the command acts on (a correction that withdraws a calculation or changes an executed target in a later
--      step), both steps count: the person involved in the step whose act raised the exception is not independent of
--      it either. This is stricter than the engine, never weaker (docs/decisions/phase-2-open-questions.md, defaults
--      taken while fixing the Phase 2 exit review);
--   3. recipe.exception_step_involvement(batch, state, exception, before): the persons involved in those steps, as the
--      stored lists name them (recipe.step_involvement) and as the accepted commands before row `before` name them
--      (recipe.recorded_involvement, every row when NULL);
--   4. recipe.execution_content_of: the batch_exception branch names that set (the kernel refuses the signature,
--      EBMR-ESIG-044). The rest is exactly as 0310 defined it;
--   5. recipe.execution_disposition_involvement_check (the trigger ae_execution_disposition_involvement of 0310): an
--      accepted DISPOSITION_EXCEPTION whose person is in that set before the row is refused (EBMR-EXE-087);
--   6. recipe.execution_violations() reports a disposition by a person involved in any of those steps before it
--      (recipe.execution_rule_violations, replaced whole, carrying the body of 0310).
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility, the search_path and the privileges
-- of the replaced functions (execution_content_of, execution_disposition_involvement_check and
-- execution_rule_violations private to the owner). The new functions are private to the owner; every function pins its
-- search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The step instance a command acts on
-- ---------------------------------------------------------------------------------------------

-- INV-03: the step instance (header) accepted command p_cmd of type p_type acts on: its step and context, or the step of
-- the data point it names in p_points (the stored state's data points) for CORRECT_ENTRY and INVALIDATE_RESULT. NULL
-- for a command that acts on no step.
create function recipe.command_step_key(p_type text, p_cmd jsonb, p_points jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when p_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY', 'REQUEST_SKIP', 'DISPOSITION_HOLD_POINT', 'VOID_ATTEMPT', 'RAISE_EXCEPTION')
         and jsonb_typeof(p_cmd -> 'step') = 'string'
      then (p_cmd ->> 'step') || '@' || recipe.ctx_key(p_cmd -> 'context')
    when p_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT') and jsonb_typeof(p_cmd -> 'point') = 'string'
         and jsonb_typeof(p_points -> (p_cmd ->> 'point') -> 'stepKey') = 'string'
      then p_points -> (p_cmd ->> 'point') ->> 'stepKey'
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The steps an exception was raised at
-- ---------------------------------------------------------------------------------------------

-- INV-03, PR-13, PR-49: the step instances exception p_exception of batch p_batch (stored state p_state) was raised at
-- (header item 2), sorted, without duplicates; empty when there is none.
create function recipe.exception_raising_steps(p_batch uuid, p_state jsonb, p_exception text) returns text[]
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct q.k order by q.k) filter (where q.k is not null), '{}')
    from (select case when jsonb_typeof(p_state -> 'exceptions' -> p_exception -> 'source' -> 'stepKey') = 'string'
                      then p_state -> 'exceptions' -> p_exception -> 'source' ->> 'stepKey' end as k
          union all
          select recipe.command_step_key(c.command_type, c.command, p_state -> 'points')
            from recipe.execution_event e
            join recipe.execution_command c on c.batch_id = e.batch_id and c.seq = e.row_seq
           where e.batch_id = p_batch and e.event_type = 'EXCEPTION_RAISED' and e.event ->> 'exception' = p_exception
             and c.kind = 'COMMAND' and c.accepted and not recipe.is_system_fact(e.event ->> 'exceptionType')) q
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The persons involved in them
-- ---------------------------------------------------------------------------------------------

-- INV-03: the persons involved in the steps exception p_exception was raised at, as their stored lists and the accepted
-- commands before row p_before (every row when NULL) name them. A sorted JSON array of person ids.
create function recipe.exception_step_involvement(p_batch uuid, p_state jsonb, p_exception text, p_before bigint) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(distinct p.v order by p.v), '[]'::jsonb)
    from unnest(recipe.exception_raising_steps(p_batch, p_state, p_exception)) k (step_key)
   cross join lateral jsonb_array_elements(recipe.step_involvement(p_state -> 'steps' -> k.step_key)
                                           || recipe.recorded_involvement(p_batch, p_state -> 'points', k.step_key, p_before)) p (v)
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The content provider
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.execution_content_of(p_type text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_table regclass := recipe.content_table(p_type);
  v_row   record;
  v_batch uuid;
  v_key   text;
  b       recipe.batch_execution;
  st      jsonb;
  x       jsonb;
  v_state text;
  v_by    uuid[] := '{}';
  v_act   jsonb;
  v_ended bigint;
  v_dev   uuid;
  v_dec   jsonb;
begin
  if v_table is null or p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+$' then
    return jsonb_build_object('exists', false);
  end if;
  v_batch := split_part(p_id, ':', 1)::uuid;
  v_key := substr(p_id, 38);
  execute format('select content_version, content from %s where aggregate_id = $1 order by content_version desc limit 1', v_table) into v_row using p_id;
  if v_row.content_version is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into b from recipe.batch_execution where id = v_batch;
  select state into st from recipe.execution_state where batch_id = v_batch;
  case p_type
    when 'batch_step' then
      x := st -> 'steps' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(coalesce(x -> 'performers', '[]') || coalesce(x -> 'dataEnterers', '[]') || coalesce(x -> 'correctors', '[]')
                                || coalesce(x -> 'performedSigners', '[]'));
      v_ended := recipe.micros_of(x -> 'endedAt');
      if v_ended is not null then
        select c.device_id into v_dev from recipe.execution_command c
         where c.batch_id = v_batch and c.accepted and c.command_type = 'SIGN_PERFORMED'
           and recipe.instance_aggregate(v_batch, c.command ->> 'step', c.command -> 'context') = p_id
         order by c.seq desc limit 1;
        if v_dev is not null then
          v_act := jsonb_build_object('device_id', v_dev, 'at', timestamptz 'epoch' + make_interval(secs => 0) + (v_ended::text || ' microseconds')::interval,
                                      'next_step_started', recipe.next_step_started(st, v_key, v_ended));
        end if;
      end if;
      -- The hold-point decision being signed is part of the signed content once it is proposed
      -- (recipe.propose_hold_point_decision; P26, P38). Without a proposal the content is the one signed before 0295.
      if v_row.content -> 'step' ->> 'kind' = 'HOLD' then
        v_dec := recipe.current_decision(p_id, v_row.content_version);
        if jsonb_typeof(v_dec) = 'object' or v_row.content ? 'proposedDecision' then
          v_row.content := v_row.content || jsonb_build_object('proposedDecision', v_dec);
        end if;
      end if;
    when 'batch_stage' then
      x := st -> 'stages' -> v_key;
      v_state := case when (x -> 'signOff' ->> 'valid')::boolean is true then 'SIGNED_OFF'
                      when (x ->> 'awaitingSignOff')::boolean is true or x ? 'endedAt' then 'AWAITING_SIGN_OFF'
                      else 'IN_PROGRESS' end;
    when 'batch_exception' then
      x := st -> 'exceptions' -> v_key;
      v_state := x ->> 'status';
      -- The raiser and the person who linked the deviation, and (F11; INV-03, PR-13, PR-49) everyone involved in the
      -- step the exception was raised at, as the stored step lists name them and (round 2) as the accepted commands
      -- recorded on that step name them: the kernel never lets them sign its disposition (EBMR-ESIG-044). Round 3: the
      -- raising step is also the step the command of the row that raised the exception acts on (header item 2).
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy')
                                || recipe.exception_step_involvement(v_batch, st, v_key, null));
      -- The disposition being signed is part of the signed content (recipe.propose_disposition).
      v_row.content := v_row.content || jsonb_build_object('proposedDisposition', recipe.current_proposal(p_id, v_row.content_version));
    when 'batch_point' then
      x := st -> 'points' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'enteredBy'));
  end case;
  -- The content is returned exactly as stored (its null members are part of the signed text); only an
  -- absent act is left out.
  return jsonb_build_object(
    'exists', true, 'content_version', v_row.content_version, 'content', v_row.content, 'state', v_state,
    'entered_by', to_jsonb(v_by), 'scope', jsonb_build_object('site', b.site_code))
    || case when v_act is null then '{}'::jsonb else jsonb_build_object('act', v_act) end;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. The disposition row
-- ---------------------------------------------------------------------------------------------

-- INV-03, PR-13, PR-49 (F11, round 3): an accepted DISPOSITION_EXCEPTION is not by a person involved, before it, in a
-- step the exception was raised at (header items 2 and 3). Raises; never changes the row.
create or replace function recipe.execution_disposition_involvement_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  st     jsonb;
  v_step text;
begin
  if new.kind is distinct from 'COMMAND' or new.accepted is not true or new.command_type is distinct from 'DISPOSITION_EXCEPTION' then
    return new;
  end if;
  -- The stored state before the row (recipe.write_row writes the row first, then the state that names it).
  select s.state into st from recipe.execution_state s where s.batch_id = new.batch_id;
  foreach v_step in array recipe.exception_raising_steps(new.batch_id, st, new.command ->> 'exception') loop
    if (recipe.step_involvement(st -> 'steps' -> v_step) || recipe.recorded_involvement(new.batch_id, st -> 'points', v_step, new.seq)) ? coalesce(new.actor_person::text, '') then
      raise exception using errcode = 'P0001',
        message = format('%s started, entered data in, corrected or signed performed step %s, which raised exception %s, as the accepted commands recorded on that step show, so the disposition is refused: an exception is decided by a person outside the work that raised it (INV-03, PR-13, PR-49). [EBMR-EXE-087]',
                         new.actor_person, v_step, coalesce(new.command ->> 'exception', 'null'));
    end if;
  end loop;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. The invariant query
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.execution_rule_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
#variable_conflict use_column
declare
  r         record;
  v_tree    jsonb;
  v_problem text;
begin
  -- INV-03, PR-13, PR-49 (F11): an accepted disposition of an exception raised at a step, by a person whose involvement
  -- in that step an accepted command recorded before it: the command itself (round 2, recipe.recorded_involvement), or
  -- an INVOLVEMENT event of it. Round 3: every step the exception was raised at (recipe.exception_raising_steps: the
  -- stored source's step and the step the raising row's command acts on).
  for r in
    select d.batch_id as bid, d.seq, d.command ->> 'exception' as exc, d.actor_person, x.step_key
      from recipe.execution_command d
      join recipe.execution_state s on s.batch_id = d.batch_id
     cross join lateral unnest(recipe.exception_raising_steps(d.batch_id, s.state, d.command ->> 'exception')) x (step_key)
     where d.kind = 'COMMAND' and d.accepted and d.command_type = 'DISPOSITION_EXCEPTION'
       and (recipe.recorded_involvement(d.batch_id, s.state -> 'points', x.step_key, d.seq) ? d.actor_person::text
            or exists (select 1
                         from recipe.execution_command c
                         join recipe.execution_event e on e.batch_id = c.batch_id and e.row_seq = c.seq
                        where c.batch_id = d.batch_id and c.seq < d.seq and c.kind = 'COMMAND' and c.accepted
                          and e.event_type = 'INVOLVEMENT' and e.event ->> 'stepKey' = x.step_key and e.event ->> 'person' = d.actor_person::text
                          and e.event ->> 'involvement' in ('STARTED', 'ENTERED_DATA', 'PERFORMED', 'CORRECTED', 'VOIDED', 'SIGNED_HOLD_POINT')))
     order by d.batch_id, d.seq, x.step_key
  loop
    batch_id := r.bid;
    problem := format('row %s: exception %s was dispositioned by %s, who was involved in step %s, which raised it (INV-03, PR-13, PR-49)',
                      r.seq, r.exc, r.actor_person, r.step_key);
    return next;
  end loop;

  for r in
    select s.batch_id as bid, s.state, pk.content
      from recipe.execution_state s
      join recipe.batch_execution b on b.id = s.batch_id
      join recipe.test_package pk on pk.package_hash = b.package_hash
     order by s.batch_id
  loop
    v_tree := recipe.flow_tree(r.content);
    -- DI-34, PR-13 (F66): every step instance came after the steps before it.
    for v_problem in
      select format('step instance %s: %s (DI-34, PR-13)', i.key, q.p)
        from jsonb_each(case when jsonb_typeof(r.state -> 'steps') = 'object' then r.state -> 'steps' else '{}'::jsonb end) i
       cross join lateral (
         select coalesce(recipe.step_order_problem(v_tree, r.state, i.value, null),
                         case when i.value ->> 'status' is distinct from 'NOT_APPLICABLE' then
                           case when jsonb_typeof(i.value -> 'enabledSeq') = 'number'
                                then recipe.step_order_problem(v_tree, r.state, i.value, (i.value ->> 'enabledSeq')::numeric)
                                else 'it has no sequence number of its enabling' end end) as p) q
       where q.p is not null
       order by i.key
    loop
      batch_id := r.bid;
      problem := v_problem;
      return next;
    end loop;
    -- INV-20, PR-30 (F67): no phase or hold-point event came before a minimum ending in it.
    for v_problem in
      select format('the %s (INV-20, PR-30)', q.p)
        from jsonb_each(case when jsonb_typeof(r.state -> 'nodeEvents') = 'object' then r.state -> 'nodeEvents' else '{}'::jsonb end) e
       cross join lateral (
         select recipe.minimum_duration_problem(
                  r.content, v_tree,
                  jsonb_build_object('nodeEvents', coalesce((select jsonb_object_agg(o.key, o.value)
                                                               from jsonb_each(r.state -> 'nodeEvents') o
                                                              where recipe.micros_of(o.value -> 'at') < recipe.micros_of(e.value -> 'at')), '{}'::jsonb)),
                  jsonb_build_object('nodeEvents', jsonb_build_object(e.key, e.value))) as p) q
       where q.p is not null and v_tree -> 'ids' -> (e.value ->> 'node') ->> 'kind' in ('phase', 'holdPoint')
       order by e.key
    loop
      batch_id := r.bid;
      problem := v_problem;
      return next;
    end loop;
  end loop;
end
$$;

revoke all on function recipe.command_step_key(text, jsonb, jsonb), recipe.exception_raising_steps(uuid, jsonb, text),
                       recipe.exception_step_involvement(uuid, jsonb, text, bigint) from public;

-- Privileges: CREATE OR REPLACE kept those of 0310 (execution_content_of, execution_disposition_involvement_check and
-- execution_rule_violations private to the owner).

reset role;
