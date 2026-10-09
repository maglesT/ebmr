-- Recipe core, execution store (module C3): an exception a row raises names the step instance the engine raises it at,
-- and that step is one the row's act reaches (Phase 2 exit review F11, round-3 verification; INV-03, PR-13, PR-49,
-- DI-17, DI-26; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- 0315 reads the steps an exception was raised at as the union of the stored source.stepKey and the step the command of
-- the accepted row that raised it acts on. The engine raises some exceptions at another step than the one the command
-- acts on, and there the stored source was still the writer's. The round-3 verification ran a correction of the blend
-- time in step A (p-early-time) that made the blend ratio computed in step B (p-early-calc) fail: the engine raises
-- CALCULATION_FAILED at B. The row was stored through the application role with stepKey and step deleted from both
-- exceptions; the raising steps were then A alone, and operator1, who had worked only in B and also held QA_SHOP_FLOOR,
-- signed and stored the disposition: the database answered 'ok' and the invariant query reported nothing, while the
-- engine on the honest state refuses it (ENG-SEGREGATION).
--
-- Where the engine raises an exception (engine tx.ts raise and its callers), as read for this migration:
--   * at the step the row acts on (the step and context of a step command, the step of the data point a CORRECT_ENTRY or
--     INVALIDATE_RESULT names, the step a PREPARE row finalises for its PERFORMED signature): the blocks' own types on an
--     entry or on PERFORMED (CLEARANCE_FAILED, EQUIPMENT_STATUS_FAILED, DISPENSE_OUT_OF_TOLERANCE, ...), ACCEPTANCE_
--     CRITERION_FAILED, CALCULATION_FAILED of a calculation of that step, POST_ENTRY_CORRECTION, RESULT_INVALIDATED,
--     ABORTED_ATTEMPT, REPEAT_ATTEMPT, REPEAT_AFTER_FAIL, MANUAL_ENTRY_FALLBACK, LATE_ENTRY, STEP_SKIPPED, WITNESS_LATE
--     and HOLD_POINT_NOT_APPROVED;
--   * at another step, by a correction or an invalidation (corrections.ts propagate): CALCULATION_FAILED in a step whose
--     computed value the changed value feeds (a computed value withdrawn because its inputs are gone, naming it in
--     source.derived, or a recomputation that fails), and EXECUTED_TARGET_CHANGED in a step whose target the changed
--     value feeds. This is the hole of the round-3 verification;
--   * at another step, a limit verdict (LIMIT_BREACH, YIELD_OUT_OF_LIMITS) on a value recomputed in a later step or on
--     a loop's endpoint judged at the loop's exit: 0305 derives these member for member, their source included;
--   * at no step: the flow findings (DECISION_NOT_EVALUABLE, REPLICATE_COUNT_INVALID, LOOP_EXHAUSTED,
--     DECISION_AFFECTING_CORRECTION; source {frames, construct}), the time findings of the system (0299) and an
--     operator's exception without a step (0298).
-- The same hole had two more doors in the rows 0315 reads: an exception raised in a PREPARE row (the finalisation of a
-- PERFORMED signature) or in a refused COMMAND row (a refused SIGN_PERFORMED keeps the facts its finalisation
-- established) was not read by 0315 at all, so stored without its step it named no raising step; and a row whose act is
-- on no step (the issue, a loop iteration, a choice, a stage sign-off, a deviation link, a disposition) could add an
-- exception of a type the engine raises at a step, stored without one.
--
-- This migration:
--   1. recipe.row_step_key(kind, command, points): the step instance a row acts on: command_step_key (0315) for a
--      COMMAND row, accepted or refused; the target step of a PREPARE row for a PERFORMED signature; NULL otherwise;
--   2. recipe.exception_source_problem(content, old, new, kind, accepted, command), run by the row trigger
--      zzb_execution_exception_source (after insert or update on recipe.execution_state, every row, the issue
--      included): every exception the row adds, of a type the engine raises at a step (every type but an operator's
--      exception, the time findings and the flow findings), names the step instance it was raised at, as the engine
--      writes it (source.stepKey a step instance of the state, source.step and source.frames that instance's); apart
--      from a limit verdict (0305 binds its step), that step is the one the row acts on, or, for a CALCULATION_FAILED or
--      EXECUTED_TARGET_CHANGED of an accepted CORRECT_ENTRY or INVALIDATE_RESULT, a step the change reaches as the engine
--      reaches it (recipe.change_reaches_step: the step holds a current computed value whose inputs name the value the
--      command replaces or a computed value the row supersedes, and a computed value its source names is that step's
--      of that item; for a target, the step reads the item and its target was taken from such a value). A
--      CALCULATION_FAILED is at a step that computes its item (recipe.step_computes), and an EXECUTED_TARGET_CHANGED is
--      never taken as raised at the row's own step without that reach: placed at the step the row acts on, either would
--      otherwise drop the later step from the raising steps. A flow finding names no step. Anything else is refused
--      (EBMR-EXE-044, the code of the rules on exceptions as raised);
--   3. recipe.exception_raising_steps (0315) also reads the PREPARE rows and the refused COMMAND rows that raised the
--      exception (row_step_key), so an exception landed without its step behind the triggers' back is still that step's;
--   4. recipe.execution_rule_violations (0315, replaced whole, its body carried): an exception of a type the engine
--      raises at a step that names no step instance of the stored state is reported (INV-03, PR-13, PR-49).
-- So the stored source of every new exception is the step the engine raised it at, and the content provider, the
-- disposition trigger (EBMR-EXE-087) and the invariant arm of 0315 read the right step. Where a correction raises at a
-- later step, both steps still count (decision F11.1, stricter than the engine).
--
-- Not derived here, stated so it is not over-read: which of several step instances the change reaches gets which
-- exception (a step reached in two loop iterations, each holding a computed value the change feeds, may have the
-- writer's choice of the two), whether the engine raises a given exception at all, and its title and flags; those stay
-- with the replay verification (ADR 0010; decision REPLAY-GATE.1, the release gate replays the stored rows).
--
-- New functions are owned by ebmr_owner, private to the owner and pin their search_path with pg_temp last; the trigger
-- function is SECURITY DEFINER. CREATE OR REPLACE keeps the owner, volatility, search_path and privileges of
-- recipe.exception_raising_steps and recipe.execution_rule_violations (private to the owner). Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The step instance a row acts on
-- ---------------------------------------------------------------------------------------------

-- INV-03: the step instance (header) a row of kind p_kind with command p_command acts on, the stored state's data points
-- being p_points: a COMMAND row's (recipe.command_step_key, accepted or refused), a PREPARE row's for a PERFORMED
-- signature (the step it finalises); NULL for any other row.
create function recipe.row_step_key(p_kind text, p_command jsonb, p_points jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when p_kind = 'COMMAND' then recipe.command_step_key(p_command ->> 'type', p_command, p_points)
    when p_kind = 'PREPARE' and p_command -> 'target' ->> 'type' = 'SIGN_PERFORMED' and jsonb_typeof(p_command -> 'target' -> 'step') = 'string'
      then (p_command -> 'target' ->> 'step') || '@' || recipe.ctx_key(p_command -> 'target' -> 'context')
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The source of a new exception
-- ---------------------------------------------------------------------------------------------

-- The exception types the engine raises at a construct, at no step (advance.ts, corrections.ts).
create function recipe.exception_at_construct(p_type text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_type in ('DECISION_NOT_EVALUABLE', 'REPLICATE_COUNT_INVALID', 'LOOP_EXHAUSTED', 'DECISION_AFFECTING_CORRECTION'), false)
$$;

-- The exception types the engine always raises at a step instance: every type but an operator's exception (a step or
-- none, 0298), the time findings of the system (0299) and the flow findings.
create function recipe.exception_at_step(p_type text) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select p_type is not null and p_type <> 'OPERATOR_RAISED' and not recipe.is_system_fact(p_type) and not recipe.exception_at_construct(p_type)
$$;

-- Whether exception source p_source names a step instance of state p_state as the engine writes it: its stepKey a step
-- instance, its step and frames that instance's.
create function recipe.source_names_instance(p_state jsonb, p_source jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_typeof(p_source -> 'stepKey') = 'string'
                  and jsonb_typeof(p_state -> 'steps' -> (p_source ->> 'stepKey')) = 'object'
                  and p_source -> 'step' = p_state -> 'steps' -> (p_source ->> 'stepKey') -> 'step'
                  and p_source -> 'frames' = p_state -> 'steps' -> (p_source ->> 'stepKey') -> 'frames', false)
$$;

-- Whether provenance p_prov ({points, derived}: a computed value's input, a step's target) names one of p_ids.
create function recipe.provenance_names_any(p_prov jsonb, p_ids text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(exists (select 1
                            from jsonb_array_elements_text(case when jsonb_typeof(p_prov -> 'points') = 'array' then p_prov -> 'points' else '[]'::jsonb end
                                                           || case when jsonb_typeof(p_prov -> 'derived') = 'array' then p_prov -> 'derived' else '[]'::jsonb end) r (id)
                           where r.id = any (p_ids)), false)
$$;

-- Whether the MBR step p_step of content p_content computes calculation p_item (its node's computes).
create function recipe.step_computes(p_content jsonb, p_step text, p_item jsonb) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_typeof(p_item) = 'string' and jsonb_typeof(recipe.step_node(p_content, p_step) -> 'computes') = 'array'
                  and (recipe.step_node(p_content, p_step) -> 'computes') ? (p_item #>> '{}'), false)
$$;

-- INV-03, PR-13, PR-49 (F11, round 4): whether the change of an accepted CORRECT_ENTRY or INVALIDATE_RESULT (command
-- p_command, state p_old before the row and p_new after it, MBR content p_content) reaches the step p_source names, as
-- the engine's propagate reaches it for an exception of type p_type (header item 2). The values the change replaces:
-- the data point the command names and every computed value the row supersedes. A CALCULATION_FAILED: the step holds
-- a current computed value whose inputs name one of them, and a computed value its source names is that step's of the
-- item (the caller has checked that the step computes the item). An EXECUTED_TARGET_CHANGED: the step reads the item
-- and its target of the item was taken from one of them.
create function recipe.change_reaches_step(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb, p_type text, p_source jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key     text := p_source ->> 'stepKey';
  v_item    text := case when jsonb_typeof(p_source -> 'item') = 'string' then p_source ->> 'item' end;
  v_changed text[];
  v_dv      jsonb;
begin
  if v_item is null then
    return false;
  end if;
  select coalesce(array_agg(q.id), '{}') into v_changed
    from (select p_command ->> 'point' as id where jsonb_typeof(p_command -> 'point') = 'string'
          union all
          select d.key
            from jsonb_each(case when jsonb_typeof(p_new -> 'derived') = 'object' then p_new -> 'derived' else '{}'::jsonb end) d
           where d.value ->> 'status' = 'SUPERSEDED' and coalesce(p_old -> 'derived' -> d.key ->> 'status', 'CURRENT') = 'CURRENT') q;
  if p_type = 'CALCULATION_FAILED' then
    if p_source ? 'derived' then
      v_dv := case when jsonb_typeof(p_source -> 'derived') = 'string' then p_old -> 'derived' -> (p_source ->> 'derived') end;
      if v_dv ->> 'stepKey' is distinct from v_key or v_dv ->> 'calculation' is distinct from v_item then
        return false;
      end if;
    end if;
    return exists (select 1
                     from jsonb_each(case when jsonb_typeof(p_old -> 'derived') = 'object' then p_old -> 'derived' else '{}'::jsonb end) d
                    cross join lateral jsonb_array_elements(case when jsonb_typeof(d.value -> 'inputs') = 'array' then d.value -> 'inputs' else '[]'::jsonb end) i (v)
                    where d.value ->> 'stepKey' = v_key and d.value ->> 'status' = 'CURRENT' and recipe.provenance_names_any(i.v, v_changed));
  end if;
  return p_type = 'EXECUTED_TARGET_CHANGED'
         and coalesce(jsonb_typeof(recipe.step_node(p_content, p_source ->> 'step') -> 'reads') = 'array'
                      and (recipe.step_node(p_content, p_source ->> 'step') -> 'reads') ? v_item, false)
         and recipe.provenance_names_any(p_old -> 'steps' -> v_key -> 'targets' -> v_item, v_changed);
end
$$;

-- INV-03, PR-13, PR-49, DI-26 (F11, round 4): why an exception that state p_new adds (not in p_old), stored by a row of
-- kind p_kind (accepted p_accepted, command p_command as recorded) of a batch of MBR content p_content, is not recorded
-- at the step the engine raises it at (header item 2); NULL when every one is. The text completes "This <row> ...".
create function recipe.exception_source_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0    jsonb := case when jsonb_typeof(p_old -> 'exceptions') = 'object' then p_old -> 'exceptions' else '{}'::jsonb end;
  v_own text;
  k     text;
  x     jsonb;
  t     text;
  src   jsonb;
begin
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) e
               where not (e0 ? e.key)
               order by e.key loop
    t := x ->> 'type';
    src := case when jsonb_typeof(x -> 'source') = 'object' then x -> 'source' else '{}'::jsonb end;
    if recipe.exception_at_construct(t) then
      if src ? 'stepKey' or src ? 'step' then
        return format('raises exception %s (%s) at step %s, although the engine raises it at a construct (%s), at no step',
                      k, t, coalesce(src ->> 'stepKey', src ->> 'step'), coalesce(src ->> 'construct', 'none'));
      end if;
      continue;
    end if;
    continue when not recipe.exception_at_step(t);
    if not recipe.source_names_instance(p_new, src) then
      return format('raises exception %s (%s) without the step instance it was raised at: its source names %s; the engine raises it at a step instance and names its key, its step and its frames',
                    k, t, case when jsonb_typeof(src -> 'stepKey') = 'string' then 'step ' || (src ->> 'stepKey') || coalesce(' (' || (src ->> 'step') || ')', '') || ', which is not such an instance of the state'
                               else 'no step' end);
    end if;
    -- A limit verdict's step is the one 0305 derives for it.
    continue when t in ('LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS');
    if t = 'CALCULATION_FAILED' and not recipe.step_computes(p_content, src ->> 'step', src -> 'item') then
      return format('raises exception %s (CALCULATION_FAILED) at step %s, whose MBR step does not compute %s', k, src ->> 'stepKey', coalesce(src ->> 'item', 'any item it names'));
    end if;
    v_own := recipe.row_step_key(p_kind, p_command, p_new -> 'points');
    -- The engine raises an executed target's change only where a correction or an invalidation reaches it.
    continue when src ->> 'stepKey' = v_own and t is distinct from 'EXECUTED_TARGET_CHANGED';
    continue when t in ('CALCULATION_FAILED', 'EXECUTED_TARGET_CHANGED') and p_kind = 'COMMAND' and p_accepted is true
                  and p_command ->> 'type' in ('CORRECT_ENTRY', 'INVALIDATE_RESULT')
                  and recipe.change_reaches_step(p_content, p_old, p_new, p_command, t, src);
    return case t
      when 'EXECUTED_TARGET_CHANGED' then
        format('raises exception %s (EXECUTED_TARGET_CHANGED) at step %s, whose target %s no value that an accepted correction or invalidation of this row replaces fed',
               k, src ->> 'stepKey', coalesce(src ->> 'item', '(none named)'))
      when 'CALCULATION_FAILED' then
        format('raises exception %s (CALCULATION_FAILED) at step %s, which is not the step instance the row acts on (%s) nor one holding a computed value that a value an accepted correction or invalidation of this row replaces fed',
               k, src ->> 'stepKey', coalesce(v_own, 'none'))
      else format('raises exception %s (%s) at step %s, which is not the step instance the row acts on (%s)', k, t, src ->> 'stepKey', coalesce(v_own, 'none')) end;
  end loop;
  return null;
end
$$;

-- INV-03, PR-13, PR-49, DI-26 (F11, round 4): every exception a row adds is recorded at the step the engine raises it at
-- (header item 2). EBMR-EXE-044. Raises; returns nothing.
create function recipe.execution_exception_source_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_old     jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end) k
                  where not coalesce((v_old -> 'exceptions') ? k, false)) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.exception_source_problem(v_content, v_old, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an exception is recorded at the step instance the engine raises it at, the step its row acts on or, for what a correction or an invalidation recomputes, a step the changed value feeds, so the persons involved in that step stay excluded from its disposition (INV-03, PR-13, PR-49, DI-26). [EBMR-EXE-044]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- After zz_execution_system_facts (0299), so the rules on the raiser and the events of a new exception answer first.
create trigger zzb_execution_exception_source after insert or update on recipe.execution_state
  for each row execute function recipe.execution_exception_source_check();

-- ---------------------------------------------------------------------------------------------
-- 3. The steps an exception was raised at (0315), from every row that raised it
-- ---------------------------------------------------------------------------------------------

-- INV-03, PR-13, PR-49: the step instances exception p_exception of batch p_batch (stored state p_state) was raised at:
-- the stored source's step and the step each row whose EXCEPTION_RAISED event names it acts on (header item 3), sorted,
-- without duplicates; empty when there is none. A time finding of the system keeps only its stored source (0299).
create or replace function recipe.exception_raising_steps(p_batch uuid, p_state jsonb, p_exception text) returns text[]
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct q.k order by q.k) filter (where q.k is not null), '{}')
    from (select case when jsonb_typeof(p_state -> 'exceptions' -> p_exception -> 'source' -> 'stepKey') = 'string'
                      then p_state -> 'exceptions' -> p_exception -> 'source' ->> 'stepKey' end as k
          union all
          select recipe.row_step_key(c.kind, c.command, p_state -> 'points')
            from recipe.execution_event e
            join recipe.execution_command c on c.batch_id = e.batch_id and c.seq = e.row_seq
           where e.batch_id = p_batch and e.event_type = 'EXCEPTION_RAISED' and e.event ->> 'exception' = p_exception
             and c.kind in ('COMMAND', 'PREPARE') and not recipe.is_system_fact(e.event ->> 'exceptionType')) q
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The invariant query
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
  -- stored source's step and the step the raising row's command acts on; round 4, sql 0327: a PREPARE or refused row
  -- that raised it too).
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

  -- INV-03, PR-13, PR-49 (F11, round 4): an exception of a type the engine raises at a step that names no step instance
  -- of the stored state (header item 4).
  for r in
    select s.batch_id as bid, e.key as exc, e.value ->> 'type' as typ
      from recipe.execution_state s
     cross join lateral jsonb_each(case when jsonb_typeof(s.state -> 'exceptions') = 'object' then s.state -> 'exceptions' else '{}'::jsonb end) e
     where recipe.exception_at_step(e.value ->> 'type')
       and not recipe.source_names_instance(s.state, case when jsonb_typeof(e.value -> 'source') = 'object' then e.value -> 'source' else '{}'::jsonb end)
     order by s.batch_id, e.key
  loop
    batch_id := r.bid;
    problem := format('exception %s (%s) names no step instance it was raised at, although the engine raises it at a step (INV-03, PR-13, PR-49)', r.exc, r.typ);
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

revoke all on function recipe.row_step_key(text, jsonb, jsonb), recipe.exception_at_construct(text), recipe.exception_at_step(text),
                       recipe.source_names_instance(jsonb, jsonb), recipe.provenance_names_any(jsonb, text[]), recipe.step_computes(jsonb, text, jsonb),
                       recipe.change_reaches_step(jsonb, jsonb, jsonb, jsonb, text, jsonb),
                       recipe.exception_source_problem(jsonb, jsonb, jsonb, text, boolean, jsonb),
                       recipe.execution_exception_source_check() from public;

-- Privileges: CREATE OR REPLACE kept those of 0315 (exception_raising_steps and execution_rule_violations private to the
-- owner).

reset role;
