-- Recipe core, execution store (module C3): what the state has recorded stays recorded, in every row, and a time
-- sweep changes nothing but the time findings and their bookkeeping (review findings P34, P58 and P36, round-2
-- verification; DI-24, DI-29, DI-30, DI-32, DI-33, DI-27, INV-20, INV-41; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- 0300 (trigger zb_execution_state_binding) binds the state a person's row stores to the command the row records.
-- The round-2 verification found two holes in it:
--   (a) it compares only what is NEW: a data point or an entry whose key the row adds. A point, entry, container or
--       computed (derived) value already in the state could be rewritten by any later row, accepted or refused, from
--       any room: an accepted RAISE_EXCEPTION from another terminal stored the earlier hand entry of 15 min as a
--       SCAN of 16 min, with no correction, no second version and no signature; the database recorded it and
--       execution_violations() stayed empty; only the replay (ADR 0010) disagreed;
--   (b) it returns at once for a SWEEP row. The in-process sweeper, whose service key the server holds, could store
--       any state beside its sweep: relabel the hand entry as a scan, clear verificationRequired and complete a step
--       that was waiting for its second person. 0299 checks only the exceptions and the time bookkeeping of a sweep.
--
-- This migration adds a companion row trigger on recipe.execution_state (zc_execution_recorded_state; row triggers fire
-- in name order, so after 0300's zb_execution_state_binding and before zz_execution_system_facts of 0280 and 0299),
-- for every row that updates the projection (COMMAND and PREPARE of any source, accepted or refused, and SWEEP):
--
--   EBMR-EXE-128  A SWEEP row stores the state before it, changed only as the engine's sweep changes it (engine.ts
--                 sweep: openTx and timing.ts sweepTime): the last time seen, the constraint instances and the new
--                 exceptions (all three proved by 0299, the exceptions already recorded kept by 0270's
--                 check_exception_changes), the event counter (moved on by exactly the events of the row) and the
--                 exception counter (moved on by exactly the exceptions the row adds). Everything else, the steps,
--                 data points, entries, containers, computed values, decisions, stages, holds, sub-lots, node events,
--                 applied commands, used signatures, the marking, the status and the version, is byte-identical.
--
--   EBMR-EXE-126  In any other row, what the state has recorded is kept as recorded. A data point, entry, container
--                 or computed value of the state before the row is never removed, and none of its facts (value,
--                 source, flags, person, item, step, times, attempt and version, data) changes. The engine changes
--                 an existing record only as follows, and the database accepts only these changes (enumerated from
--                 engine corrections.ts, data.ts, steps.ts and advance.ts):
--                   * a data point is marked SUPERSEDED, naming the new version the same row adds (which names it
--                     back, for the same item and step): by the accepted CORRECT_ENTRY that names it, when it was
--                     keyed by hand and the new version keeps its source (path a); or, for a value the block computes
--                     (source BLOCK), by the PERFORMED signature of its own step, whose finalisation recomputes it
--                     (accepted, refused or its PREPARE row: the finalisation stays recorded in each);
--                   * a data point is marked INVALIDATED, with its invalidation record naming the approval the
--                     command carries: by the accepted INVALIDATE_RESULT that names it (path c);
--                   * a loop endpoint that was waiting for the loop's exit (evaluation ENDPOINT_IN_PROGRESS) gets its
--                     verdict (evaluation, failed) and the exceptions the row raises for it: by the accepted
--                     COMPLETE_LOOP_ITERATION whose decision (new in the row) ends the loop, EXIT or EXHAUSTED, for a
--                     point of that iteration, one point per row;
--                   * a computed value is marked SUPERSEDED by the recomputation of its calculation, which adds the
--                     new value that supersedes it (same calculation and step): in its own step by the accepted
--                     START_STEP, RECORD_DATA or RECORD_ENTRY or the PERFORMED signature (as above), in any step by an
--                     accepted CORRECT_ENTRY or INVALIDATE_RESULT (the dependents of the changed value); or, by such a
--                     correction or invalidation, withdrawn with the CALCULATION_FAILED exception the row raises for it;
--                   * a container in quarantine is marked CONSUMED, by the step that charges it: the accepted
--                     RECORD_ENTRY of that step.
--                 The same rows alone add records of these kinds that 0300 does not look at: a computed value only in
--                 a row that computes that step's calculations (as above); a container only in the accepted
--                 RECORD_ENTRY of the step that produces it, in quarantine.
--
-- As in 0300, the database does not re-run the engine; the rest of the state is left to the replay verification.
-- What the checks do not decide, stated so they are not over-read: which of the points of a loop iteration is the
-- endpoint (the MBR's loop names it, the check reads the frames and the waiting evaluation only), and the values of
-- a new version or a new computed value (the replay compares them).
--
-- The core of both checks is in two pure functions (recipe.sweep_state_problem, recipe.kept_records_problem) so
-- that they can be compared with the engine without a batch (packages/recipe-core/test/execution
-- kept-records-sql.test.ts). New functions and the trigger function are owned by ebmr_owner, private to the owner
-- (no EXECUTE for PUBLIC), the trigger function SECURITY DEFINER; every function pins its search_path with
-- pg_temp last. 0300 and its function are left as they are.

set local role ebmr_owner;

-- The members of objects p_old and p_new whose values differ, except those named in p_except, sorted and joined by
-- commas; NULL when there is none. Both must be JSON objects.
create function recipe.members_changed(p_old jsonb, p_new jsonb, p_except text[]) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select string_agg(q.k, ', ' order by q.k)
    from (select jsonb_object_keys(p_old) as k union select jsonb_object_keys(p_new)) q
   where not (q.k = any (coalesce(p_except, '{}'))) and (p_old -> q.k) is distinct from (p_new -> q.k)
$$;

-- Why the state p_new a SWEEP row stores, after state p_old, with p_events events, is not what the engine's time
-- sweep leaves (header, EBMR-EXE-128); NULL when it is. What the sweep may change is proved elsewhere: the last time
-- seen, the constraint instances and the new exceptions by 0299, the exceptions already recorded by 0270.
create function recipe.sweep_state_problem(p_old jsonb, p_new jsonb, p_events integer) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_changed text;
  v_added   integer;
  v_counter jsonb;
begin
  if jsonb_typeof(p_old) is distinct from 'object' or jsonb_typeof(p_new) is distinct from 'object'
     or jsonb_typeof(p_old -> 'exceptions') is distinct from 'object' or jsonb_typeof(p_new -> 'exceptions') is distinct from 'object'
     or jsonb_typeof(p_old -> 'counters') is distinct from 'object' or jsonb_typeof(p_new -> 'counters') is distinct from 'object'
     or jsonb_typeof(p_old -> 'seq') is distinct from 'number' or jsonb_typeof(p_new -> 'seq') is distinct from 'number' then
    return 'is malformed (its exceptions, counters or event counter)';
  end if;
  v_changed := recipe.members_changed(p_old, p_new, array['lastRecordedUs', 'seq', 'counters', 'timeInstances', 'exceptions']);
  if v_changed is not null then
    return format('changes its %s', v_changed);
  end if;
  -- Every event of the row moves the event counter on by one (tx.ts emit).
  if (p_new ->> 'seq')::numeric is distinct from (p_old ->> 'seq')::numeric + coalesce(p_events, 0) then
    return format('moves its event counter from %s to %s with %s events', p_old ->> 'seq', p_new ->> 'seq', coalesce(p_events, 0));
  end if;
  -- Every exception the sweep raises takes the next exception number (tx.ts raise, nextId('EX')); no other counter moves.
  select count(*) into v_added from jsonb_object_keys(p_new -> 'exceptions') k where not ((p_old -> 'exceptions') ? k);
  v_counter := case when v_added = 0 then p_old -> 'counters'
                    else (p_old -> 'counters') || jsonb_build_object('EX', coalesce((p_old -> 'counters' ->> 'EX')::numeric, 0) + v_added) end;
  if (p_new -> 'counters') is distinct from v_counter then
    return format('moves its counters to %s, not by the %s exceptions it adds', p_new -> 'counters', v_added);
  end if;
  return null;
end
$$;

-- Why the state p_new that a row (kind p_kind, accepted p_accepted, command p_command as recorded) stores after state
-- p_old changes, removes or adds a data point, entry, container or computed value otherwise than the engine does
-- (header, EBMR-EXE-126); NULL when it does not. The text completes "This <row> ...".
create function recipe.kept_records_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_cmd     jsonb := case when p_kind = 'PREPARE' then p_command -> 'target' else p_command end;
  v_type    text;
  v_key     text := recipe.row_step_key(p_kind, p_command);
  v_done    boolean := p_kind = 'COMMAND' and p_accepted is true;
  -- Rows that compute the calculations of their own step (steps.ts, finalisePerform), and rows that recompute the
  -- dependents of a changed value in any step (corrections.ts propagate).
  v_own     boolean;
  v_any     boolean;
  v_new_ex  jsonb;
  v_dkey    text;
  v_exit    boolean;
  v_evals   integer := 0;
  v_what    text;
  v_changed text;
  m         text;
  k         text;
  x         jsonb;
  y         jsonb;
  n         jsonb;
begin
  v_type := v_cmd ->> 'type';
  foreach m in array array['points', 'entries', 'containers', 'derived', 'exceptions', 'decisions'] loop
    if jsonb_typeof(p_old -> m) is distinct from 'object' or jsonb_typeof(p_new -> m) is distinct from 'object' then
      return format('stores a state whose %s are malformed', m);
    end if;
  end loop;
  v_own := (v_done and v_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY')) or v_type is not distinct from 'SIGN_PERFORMED';
  v_any := v_done and v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT');
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_new_ex
    from jsonb_each(p_new -> 'exceptions') e where not ((p_old -> 'exceptions') ? e.key);
  if v_done and v_type = 'COMPLETE_LOOP_ITERATION' and jsonb_typeof(v_cmd -> 'construct') = 'string' and jsonb_typeof(v_cmd -> 'context') = 'array' then
    v_dkey := (v_cmd ->> 'construct') || '@' || recipe.ctx_key(v_cmd -> 'context');
  end if;
  v_exit := coalesce(v_dkey is not null and not ((p_old -> 'decisions') ? v_dkey)
                     and p_new -> 'decisions' -> v_dkey ->> 'outcome' in ('EXIT', 'EXHAUSTED'), false);

  -- Entries: nothing in the engine changes one once recorded.
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'entries') e order by e.key loop
    if (p_new -> 'entries' -> k) is distinct from x then
      return format('%s entry %s (%s of step %s)', case when (p_new -> 'entries') ? k then 'changes' else 'removes' end,
                    k, coalesce(x ->> 'kind', '?'), coalesce(x ->> 'stepKey', '(none)'));
    end if;
  end loop;

  -- Data points.
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'points') e order by e.key loop
    y := p_new -> 'points' -> k;
    v_what := format('data point %s (%s of step %s)', k, coalesce(x ->> 'item', '?'), coalesce(x ->> 'stepKey', '(none)'));
    if y is null then
      return format('removes %s', v_what);
    end if;
    if y = x then
      continue;
    end if;
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(y) is distinct from 'object' then
      return format('changes %s, which is malformed', v_what);
    end if;
    v_changed := recipe.members_changed(x, y, array['status', 'supersededBy', 'invalidation', 'evaluation', 'failed', 'exceptions']);
    if v_changed is not null then
      return format('changes the %s of %s', v_changed, v_what);
    end if;
    if (y -> 'status') is distinct from (x -> 'status') then
      if x ->> 'status' = 'VALID' and y ->> 'status' = 'SUPERSEDED' then
        n := case when jsonb_typeof(y -> 'supersededBy') = 'string' and not ((p_old -> 'points') ? (y ->> 'supersededBy'))
                  then p_new -> 'points' -> (y ->> 'supersededBy') end;
        if not coalesce(not (x ? 'supersededBy') and (y - 'status' - 'supersededBy') = (x - 'status')
                        and jsonb_typeof(n) = 'object' and n ->> 'supersedes' = k
                        and (n -> 'item') = (x -> 'item') and (n -> 'stepKey') = (x -> 'stepKey')
                        and ((v_done and v_type = 'CORRECT_ENTRY' and v_cmd ->> 'point' = k
                              and x -> 'source' ->> 'mode' = 'MANUAL' and (n -> 'source') = (x -> 'source'))
                             or (v_type = 'SIGN_PERFORMED' and x ->> 'stepKey' = v_key
                                 and x -> 'source' ->> 'mode' = 'BLOCK' and n -> 'source' ->> 'mode' = 'BLOCK')), false) then
          return format('marks %s superseded; only a new version of it that the row adds supersedes a value: the accepted CORRECT_ENTRY of that hand entry, or the recomputation of a block value when its own step is signed performed', v_what);
        end if;
      elsif x ->> 'status' = 'VALID' and y ->> 'status' = 'INVALIDATED' then
        if not coalesce(not (x ? 'invalidation') and jsonb_typeof(y -> 'invalidation') = 'object' and (y - 'status' - 'invalidation') = (x - 'status')
                        and v_done and v_type = 'INVALIDATE_RESULT' and v_cmd ->> 'point' = k
                        and y -> 'invalidation' ->> 'signature' = v_cmd -> 'approval' -> 'signature' ->> 'id'
                        and y -> 'invalidation' ->> 'approvedBy' = v_cmd -> 'approval' -> 'approver' ->> 'id', false) then
          return format('marks %s invalidated; only the accepted INVALIDATE_RESULT of that value does, with the approval it carries', v_what);
        end if;
      else
        return format('changes the status of %s from %s to %s', v_what, coalesce(x ->> 'status', 'none'), coalesce(y ->> 'status', 'none'));
      end if;
    else
      -- The verdict on a loop endpoint, given at the loop's exit (data.ts raiseForEvaluationAtExit).
      if not coalesce(v_exit and (y -> 'supersededBy') is not distinct from (x -> 'supersededBy')
                      and (y -> 'invalidation') is not distinct from (x -> 'invalidation')
                      and x -> 'evaluation' ->> 'requirement' = 'ENDPOINT_IN_PROGRESS'
                      and jsonb_typeof(y -> 'evaluation') = 'object' and jsonb_typeof(y -> 'failed') = 'boolean'
                      and jsonb_typeof(x -> 'frames') = 'array' and (x -> 'frames') @> (v_cmd -> 'context')
                      and jsonb_typeof(x -> 'exceptions') = 'array' and jsonb_typeof(y -> 'exceptions') = 'array'
                      and jsonb_array_length(y -> 'exceptions') >= jsonb_array_length(x -> 'exceptions')
                      and not exists (select 1 from jsonb_array_elements(y -> 'exceptions') with ordinality e (v, i)
                                       where case when e.i <= jsonb_array_length(x -> 'exceptions') then e.v is distinct from (x -> 'exceptions' -> (e.i::integer - 1))
                                                  else not coalesce(jsonb_typeof(e.v) = 'string' and v_new_ex -> (e.v #>> '{}') -> 'source' ->> 'point' = k, false) end), false) then
        return format('changes the evaluation, verdict or exceptions of %s; only the exit of a loop whose endpoint was waiting for it (the accepted COMPLETE_LOOP_ITERATION that ends the loop) gives that verdict, with the exceptions the row raises for it', v_what);
      end if;
      v_evals := v_evals + 1;
      if v_evals > 1 then
        return format('gives more than one loop endpoint its verdict at one loop exit (%s is the second)', v_what);
      end if;
    end if;
  end loop;

  -- Computed (derived) values.
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'derived') e order by e.key loop
    y := p_new -> 'derived' -> k;
    v_what := format('computed value %s (%s of step %s)', k, coalesce(x ->> 'calculation', '?'), coalesce(x ->> 'stepKey', '(none)'));
    if y is null then
      return format('removes %s', v_what);
    end if;
    if y = x then
      continue;
    end if;
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(y) is distinct from 'object' then
      return format('changes %s, which is malformed', v_what);
    end if;
    v_changed := recipe.members_changed(x, y, array['status']);
    if v_changed is not null then
      return format('changes the %s of %s', v_changed, v_what);
    end if;
    if not coalesce(x ->> 'status' = 'CURRENT' and y ->> 'status' = 'SUPERSEDED'
                    and (((v_any or (v_own and x ->> 'stepKey' = v_key))
                          and exists (select 1 from jsonb_each(p_new -> 'derived') d
                                       where not ((p_old -> 'derived') ? d.key) and d.value ->> 'supersedes' = k
                                         and (d.value -> 'calculation') = (x -> 'calculation') and (d.value -> 'stepKey') = (x -> 'stepKey')))
                         or (v_any and exists (select 1 from jsonb_each(v_new_ex) e
                                                where e.value ->> 'type' = 'CALCULATION_FAILED' and e.value -> 'source' ->> 'derived' = k))), false) then
      return format('marks %s superseded; only the recomputation of its calculation does, by the row that computes it, with the new value (or the failure of the calculation it raises)', v_what);
    end if;
  end loop;
  for k, y in select e.key, e.value from jsonb_each(p_new -> 'derived') e where not ((p_old -> 'derived') ? e.key) order by e.key loop
    if not coalesce(jsonb_typeof(y) = 'object' and y ->> 'id' = k and (v_any or (v_own and y ->> 'stepKey' = v_key)), false) then
      return format('adds computed value %s (%s of step %s); a value is computed only by the row that computes that step''s calculations', k, coalesce(y ->> 'calculation', '?'), coalesce(y ->> 'stepKey', '(none)'));
    end if;
  end loop;

  -- Containers.
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'containers') e order by e.key loop
    y := p_new -> 'containers' -> k;
    v_what := format('container %s (%s from step %s)', k, coalesce(x ->> 'holds', '?'), coalesce(x ->> 'producedBy', '(none)'));
    if y is null then
      return format('removes %s', v_what);
    end if;
    if y = x then
      continue;
    end if;
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(y) is distinct from 'object' then
      return format('changes %s, which is malformed', v_what);
    end if;
    v_changed := recipe.members_changed(x, y, array['status', 'consumedBy']);
    if v_changed is not null then
      return format('changes the %s of %s', v_changed, v_what);
    end if;
    if not coalesce(x ->> 'status' = 'QUARANTINE' and not (x ? 'consumedBy') and y ->> 'status' = 'CONSUMED'
                    and v_done and v_type = 'RECORD_ENTRY' and y ->> 'consumedBy' = v_key, false) then
      return format('marks %s consumed; only the accepted RECORD_ENTRY of the step that charges it does', v_what);
    end if;
  end loop;
  for k, y in select e.key, e.value from jsonb_each(p_new -> 'containers') e where not ((p_old -> 'containers') ? e.key) order by e.key loop
    if not coalesce(jsonb_typeof(y) = 'object' and y ->> 'id' = k and v_done and v_type = 'RECORD_ENTRY'
                    and y ->> 'producedBy' = v_key and y ->> 'status' = 'QUARANTINE' and not (y ? 'consumedBy'), false) then
      return format('adds container %s; a container is registered, in quarantine, only by the accepted RECORD_ENTRY of the step that produces it', k);
    end if;
  end loop;
  return null;
end
$$;

-- DI-24, DI-29, DI-30, DI-32, DI-33, DI-27, INV-20, INV-41: the state a row stores keeps what was recorded (header).
-- Runs after the projection is written (recipe.write_row writes the row and its events first); the row that
-- produced the state is the one it names (last_seq). Raises; returns nothing.
create function recipe.execution_recorded_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.seq is null then
    raise exception using errcode = 'P0001', message = format('The state of batch %s names row %s, which does not exist (DI-34). [EBMR-EXE-030]', new.batch_id, new.last_seq);
  end if;
  if r.kind = 'SWEEP' then
    v_problem := recipe.sweep_state_problem(old.state, new.state, r.event_count);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Row %s is a time sweep, and the state it stores %s: a sweep records what it finds about time and the time bookkeeping, nothing else; a step, a value or any other record changes only by the act that records it (DI-27, INV-20, DI-34). [EBMR-EXE-128]',
                         r.seq, v_problem);
    end if;
    return null;
  end if;
  v_problem := recipe.kept_records_problem(old.state, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a value, entry, container or computed value once recorded is kept as recorded; it changes only as a correction, a recomputation, an approved invalidation, a charge or a loop exit changes it, by the row that makes that change (DI-24, DI-29, DI-30, DI-32, INV-41). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.accepted then 'accepted' else 'refused' end,
                       coalesce(r.command_type, r.kind), v_problem);
  end if;
  return null;
end
$$;

create trigger zc_execution_recorded_state after update on recipe.execution_state
  for each row execute function recipe.execution_recorded_state_check();

revoke all on function recipe.members_changed(jsonb, jsonb, text[]), recipe.sweep_state_problem(jsonb, jsonb, integer),
                       recipe.kept_records_problem(jsonb, jsonb, text, boolean, jsonb), recipe.execution_recorded_state_check() from public;

reset role;
