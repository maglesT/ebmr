-- Recipe core, execution store (module C3): the times a late check is measured from, and the witness window it is
-- measured against, are the record's (Phase 2 exit follow-up T12.LATE, round 2 of the lane verification; DI-35, PR-14,
-- DI-27, INV-16, INV-20, INV-26; default T12.2; ADR 0012: the rules hold when the application's own database credentials
-- are used directly).
--
-- Correction of 0333's header, stated here because applied migrations are never edited. 0333 lets a step whose witness
-- is due be checked by its later review once a witness is no longer possible, and its refusal said that "a witness
-- window that has passed or a run that moved on is the record's to say, not the writer's". That did not hold. 0333 reads
-- four facts the application role wrote and no guard bound: the end time of the step instance (endedAt), the start times
-- of the other instances and the times their data was recorded (recipe.next_step_started), and the witness window of the
-- batch's pinned engine policy (recipe.batch_execution.policy, which recipe.issue_execution only checks against its own
-- stated hash, EBMR-EXE-014). The lane verifier stored, through the application role:
--   PROBE A. operator1's PERFORMED signature on dc-mini's p-early-time@ (blend time typed by hand, the MBR naming a
--            printout, check VERIFIED) with the step's endedAt set 400 s before the row's trusted time: accepted; the
--            screen then offered only the later review, which was accepted at once with WITNESS_LATE saying that the
--            witness window had passed, although the act had just happened; the invariant query reported nothing;
--   PROBE B. a test batch issued through the normal route with the pinned policy's witnessWindowUs 1 microsecond:
--            right after the PERFORMED signature the later review was offered and accepted with WITNESS_LATE.
-- Under 0325 the database asked for WITNESSED whatever the time, so neither forgery could replace a witness (at worst the
-- run was stuck). 0333 was the first guard to read these facts and so made the replacement of a witness the writer's
-- choice. The same held for the facts recipe.next_step_started reads: a start of another step, or a value of another
-- step, dated far ahead made every later act look moved on at once.
--
-- Now:
--   * trigger zzg_execution_step_times (after insert or update of recipe.execution_state, every row; fires after the
--     other row checks, so a row one of them refuses keeps its code) with the pure function recipe.step_time_problem,
--     compared with the engine's own runs
--     (packages/recipe-core/test/execution step-times-sql.test.ts):
--       EBMR-EXE-142  a start or end time recorded for a step instance is kept as recorded: no row changes or removes it;
--       EBMR-EXE-143  a start time (startedAt) is recorded only by that instance's own accepted START_STEP, at the row's
--                     trusted database time (execution_command.now_us), as the engine starts a step (steps.ts startStep:
--                     the clock as given, the time of the START node event 0299 binds);
--       EBMR-EXE-144  an end time (endedAt) is recorded only by that instance's own accepted PERFORMED signature
--                     (SIGN_PERFORMED) or hold-point release (DISPOSITION_HOLD_POINT), at the row's trusted database
--                     time, as the engine ends it (steps.ts signPerformed, dispositionHoldPoint: the clock as given, the
--                     time of the END node event 0299 binds). The lane verifier asked for "the greater of now_us and the
--                     prior lastRecordedUs"; the two differ only when the database clock went back, and then the engine
--                     records the clock as given (and raises CLOCK_REGRESSION), so that is the value bound; 0333 measures
--                     the window from it to the later of the two, which can only shorten nothing the clock did not;
--       EBMR-EXE-145  a data point a row adds is recorded at the row's trusted time, the state's last time seen
--                     (lastRecordedUs, bound by 0299), as the engine records every value (data.ts, corrections.ts: the
--                     transaction's time). An entry's time is bound by 0330, and recorded points and entries are kept by
--                     0303, so every time recipe.next_step_started reads is now the record's;
--   * trigger ac_execution_witness_window (before insert or update of recipe.batch_execution) with the pure function
--     recipe.witness_window_problem (EBMR-EXE-146): the pinned engine policy's witness window is a whole number of
--     microseconds, no shorter than the site's witness window of the kernel at issue (esig.witness_window_seconds, which
--     esig.check_witness applies to a witness signature) and no longer than the longest the kernel allows (its catalogue
--     maximum, 1800 s). A shorter window would let the later review replace a witness the kernel still accepts; a longer
--     one only delays the later review (the step waits for the engine's window: never stuck, never weaker). The engine
--     of this release pins 300 s, the kernel's default.
-- Not decided here, stated so it is not over-read: a site that lengthens its kernel window after a batch was issued
-- leaves that batch with the window pinned at issue (ADR 0010: a batch runs on the policy it was issued with); the
-- engine's other policy members are not read by any database guard and stay with the replay (EBMR-EXE-063).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-27, DI-35, INV-16, INV-20, PR-14 (T12.LATE round 2): why the state p_new that a row (kind p_kind, accepted
-- p_accepted, command p_command as recorded, trusted database time p_now) stores after state p_old (an empty object for
-- the issue) records a step's start or end time, or a value's time, otherwise than the engine does (header); NULL when
-- it does not. Answers {code, why}; the text completes "This <row> ...".
create function recipe.step_time_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb, p_now bigint) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0     jsonb := case when jsonb_typeof(p_old -> 'steps') = 'object' then p_old -> 'steps' else '{}'::jsonb end;
  s1     jsonb := case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end;
  d0     jsonb := case when jsonb_typeof(p_old -> 'points') = 'object' then p_old -> 'points' else '{}'::jsonb end;
  d1     jsonb := case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}'::jsonb end;
  v_type text := case when p_kind = 'COMMAND' and p_accepted is true then p_command ->> 'type' end;
  v_key  text := case when jsonb_typeof(p_command -> 'step') = 'string' then (p_command ->> 'step') || '@' || recipe.ctx_key(p_command -> 'context') end;
  v_at   jsonb := case when p_now is not null then jsonb_build_object('$u', p_now::text) end;
  v_last jsonb := p_new -> 'lastRecordedUs';
  k      text;
  m      text;
  x      jsonb;
  y      jsonb;
begin
  -- EBMR-EXE-142: a recorded start or end time is kept.
  for k, x in select e.key, e.value from jsonb_each(s0) e order by e.key loop
    foreach m in array array['startedAt', 'endedAt'] loop
      if jsonb_typeof(x) = 'object' and x ? m and (s1 -> k -> m) is distinct from (x -> m) then
        return jsonb_build_object('code', 'EBMR-EXE-142', 'why',
          format('changes the %s time recorded for step %s (%s to %s)', case m when 'startedAt' then 'start' else 'end' end, k,
                 coalesce(recipe.micros_of(x -> m)::text, x ->> m), coalesce(recipe.micros_of(s1 -> k -> m)::text, s1 -> k ->> m, 'none')));
      end if;
    end loop;
  end loop;
  for k, y in select e.key, e.value from jsonb_each(s1) e order by e.key loop
    if jsonb_typeof(y) is distinct from 'object' then
      continue; -- a malformed instance is refused by 0299 (EBMR-EXE-030)
    end if;
    -- EBMR-EXE-143: a start time only by the instance's own START_STEP, at the row's time.
    if y ? 'startedAt' and not coalesce((s0 -> k) ? 'startedAt', false) then
      if v_type is distinct from 'START_STEP' or v_key is distinct from k then
        return jsonb_build_object('code', 'EBMR-EXE-143', 'why',
          format('records a start time for step %s, which only that step''s own accepted START_STEP records', k));
      end if;
      if (y -> 'startedAt') is distinct from v_at then
        return jsonb_build_object('code', 'EBMR-EXE-143', 'why',
          format('records the start of step %s at %s, not at the row''s trusted database time %s', k,
                 coalesce(recipe.micros_of(y -> 'startedAt')::text, y ->> 'startedAt', 'null'), coalesce(p_now::text, 'unknown')));
      end if;
    end if;
    -- EBMR-EXE-144: an end time only by the instance's own PERFORMED signature or hold-point release, at the row's time.
    if y ? 'endedAt' and not coalesce((s0 -> k) ? 'endedAt', false) then
      if coalesce(v_type not in ('SIGN_PERFORMED', 'DISPOSITION_HOLD_POINT'), true) or v_key is distinct from k then
        return jsonb_build_object('code', 'EBMR-EXE-144', 'why',
          format('records an end time for step %s, which only that step''s own accepted PERFORMED signature or hold-point release records', k));
      end if;
      if (y -> 'endedAt') is distinct from v_at then
        return jsonb_build_object('code', 'EBMR-EXE-144', 'why',
          format('records the end of step %s at %s, not at the row''s trusted database time %s', k,
                 coalesce(recipe.micros_of(y -> 'endedAt')::text, y ->> 'endedAt', 'null'), coalesce(p_now::text, 'unknown')));
      end if;
    end if;
  end loop;
  -- EBMR-EXE-145: a value a row adds is recorded at the row's trusted time (the state's last time seen).
  for k, y in select e.key, e.value from jsonb_each(d1) e where not (d0 ? e.key) order by e.key loop
    if recipe.micros_of(v_last) is null or (y -> 'recordedAt') is distinct from v_last then
      return jsonb_build_object('code', 'EBMR-EXE-145', 'why',
        format('records value %s (%s at %s) at %s, not at the row''s trusted time %s', k, coalesce(y ->> 'item', '?'), coalesce(y ->> 'stepKey', '?'),
               coalesce(recipe.micros_of(y -> 'recordedAt')::text, y ->> 'recordedAt', 'null'), coalesce(recipe.micros_of(v_last)::text, 'unknown')));
    end if;
  end loop;
  return null;
end
$$;

-- DI-27, DI-35, INV-16, INV-20, PR-14 (T12.LATE round 2): every row's state records the start and end of a step and the
-- time of a value as the engine does (recipe.step_time_problem; EBMR-EXE-142 to 145). Raises; returns nothing.
create function recipe.execution_step_times_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r     recipe.execution_command;
  v     jsonb;
  v_row text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v := recipe.step_time_problem(case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end, new.state, r.kind, r.accepted, r.command, r.now_us);
  if v is null then
    return null;
  end if;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  case v ->> 'code'
    when 'EBMR-EXE-142' then
      raise exception using errcode = 'P0001',
        message = format('This %s row %s: a start or end time recorded for a step is kept as recorded; the witness window and whether the run moved on are measured from it (DI-27, DI-35, INV-20). [EBMR-EXE-142]', v_row, v ->> 'why');
    when 'EBMR-EXE-143' then
      raise exception using errcode = 'P0001',
        message = format('This %s row %s: a step starts when its own START_STEP is recorded, at the time the database gave that row, never earlier or later (DI-27, INV-16, DI-35). [EBMR-EXE-143]', v_row, v ->> 'why');
    when 'EBMR-EXE-144' then
      raise exception using errcode = 'P0001',
        message = format('This %s row %s: a step ends when its own PERFORMED signature or hold-point release is recorded, at the time the database gave that row; the witness window is measured from it (DI-27, INV-16, DI-35, PR-14). [EBMR-EXE-144]', v_row, v ->> 'why');
    else
      raise exception using errcode = 'P0001',
        message = format('This %s row %s: a value is recorded at the time the database gave its row, never earlier or later; whether the run moved on after an act is read from it (DI-27, INV-16, DI-35). [EBMR-EXE-145]', v_row, v ->> 'why');
  end case;
end
$$;

create trigger zzg_execution_step_times after insert or update on recipe.execution_state
  for each row execute function recipe.execution_step_times_check();

-- DI-35, PR-14, INV-26 (T12.LATE round 2): why the witness window of engine policy p_policy (witnessWindowUs) cannot be
-- pinned at a site whose kernel witness window is p_site_seconds, the kernel allowing at most p_max_seconds (header);
-- NULL when it can. The text completes "The pinned engine policy's witness window ...".
create function recipe.witness_window_problem(p_policy jsonb, p_site_seconds bigint, p_max_seconds bigint) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_w  jsonb := case when jsonb_typeof(p_policy) = 'object' then p_policy -> 'witnessWindowUs' end;
  v_us bigint := recipe.micros_of(case when jsonb_typeof(p_policy) = 'object' then p_policy -> 'witnessWindowUs' end);
begin
  if v_us is null or v_w is distinct from jsonb_build_object('$u', v_us::text) then
    return format('is %s, not a whole number of microseconds', coalesce(v_w::text, 'missing'));
  end if;
  if p_site_seconds is null or p_max_seconds is null then
    return format('of %s microseconds cannot be compared with the site''s witness window, which is unknown', v_us);
  end if;
  if v_us < p_site_seconds * 1000000 then
    return format('of %s microseconds is shorter than the site''s witness window of %s s (esig.witness_window_seconds): the later review would replace a witness the kernel still accepts', v_us, p_site_seconds);
  end if;
  if v_us > p_max_seconds * 1000000 then
    return format('of %s microseconds is longer than the %s s the kernel allows a witness window', v_us, p_max_seconds);
  end if;
  return null;
end
$$;

-- DI-35, PR-14, INV-26 (T12.LATE round 2): a batch is pinned with a witness window the kernel's own witness rules agree
-- with (recipe.witness_window_problem; EBMR-EXE-146). Raises, or returns the row unchanged.
create function recipe.execution_witness_window_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_problem text;
begin
  v_problem := recipe.witness_window_problem(new.policy, esig.policy_int('esig.witness_window_seconds'),
                                             (select k.max_value from esig.policy_key k where k.key = 'esig.witness_window_seconds'));
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The pinned engine policy''s witness window %s; a test batch is issued only with a window no shorter than the site''s and no longer than the kernel allows, so a witness is never given up while the kernel would accept one (DI-35, PR-14, INV-26). [EBMR-EXE-146]', v_problem);
  end if;
  return new;
end
$$;

create trigger ac_execution_witness_window before insert or update of policy on recipe.batch_execution
  for each row execute function recipe.execution_witness_window_check();

revoke all on function recipe.step_time_problem(jsonb, jsonb, text, boolean, jsonb, bigint), recipe.execution_step_times_check(),
  recipe.witness_window_problem(jsonb, bigint, bigint), recipe.execution_witness_window_check() from public;

reset role;
