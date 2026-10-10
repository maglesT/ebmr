-- Recipe core, execution store (module C3): the hand-over of a step in progress, part 3: what an accepted row may store
-- (Phase 3 slice 2, plan item 3; outline 5.2.3, L-07; DI-14, DI-24, DI-26, DI-35, PR-14, INV-03, INV-31; engine 1.6.0;
-- ADR 0012: the rules hold when the application's own database credentials are used directly). 0461 catalogues the two
-- commands, 0462 checks the hand-over's signatures and the signers' roles. The database does not re-run the engine, so
-- it checks here, from the stored state before and after the row, the row's command and the accepted rows before it,
-- what the engine's guards decide (engine steps.ts handOverStep, takeOverStep):
--
--   HAND_OVER_STEP  of a step IN_PROGRESS, left ATTEMPT_HANDED_OVER with its check by a second person required, with a
--                   reason that is not blank; the outgoing performer is a person involved in the step (its stored lists
--                   or the accepted rows on it) who has not handed it over before; the incoming performer is another
--                   person of this installation, never one who handed the step over; the supervisor who records and
--                   signs it and the QA approver are neither of them nor involved in the step; the step's hand-over
--                   record gains exactly this hand-over (persons, reason as given, both signatures) and nothing else of
--                   the step changes; the row raises exactly one STEP_HANDED_OVER exception, at that step, raised by
--                   the supervisor (the register entry, A's 0440/0441 sync, writes it with the row);
--   TAKE_OVER_STEP  by the incoming performer the last accepted hand-over of that step names, of a step
--                   ATTEMPT_HANDED_OVER, left IN_PROGRESS with that person among its performers and the hand-over marked
--                   taken over; nothing else of the step changes;
--   and on every row: a step's hand-over record is never changed otherwise; no other row raises a STEP_HANDED_OVER; a
--   performer who handed a step over records no data, entry, void or PERFORMED signature in it again (their entries stay
--   theirs and valid: 0303 keeps every recorded value as recorded); no correction or invalidation changes a step while
--   it waits for its incoming performer; and the verifier of a step (INV-03, INV-31, PR-14) is none of the persons its
--   accepted rows name as involved (recorded_involvement of 0310) nor the outgoing or incoming performer of a hand-over
--   of it or the person who took it over, whatever lists the stored state holds.
--
-- The shared guards learn the new status and commands (CREATE OR REPLACE from their latest bodies; nothing else of them
-- changes):
--   * recipe.act_status_before, recipe.step_status_problem (0311): IN_PROGRESS -> ATTEMPT_HANDED_OVER by the step's own
--     accepted HAND_OVER_STEP, ATTEMPT_HANDED_OVER -> IN_PROGRESS by its own accepted TAKE_OVER_STEP;
--   * recipe.command_step_key (0315): both act on the step instance they name (involvement, an exception's raising step);
--   * recipe.execution_state_binding_check (0453): both act on the step they name and leave it ATTEMPT_HANDED_OVER or
--     IN_PROGRESS;
--   * recipe.step_facts_changed, recipe.signature_invalidation_problem (0382): STEP_HANDED_OVER is an act, not data of
--     the step (engine signing-content.ts ACT_EXCEPTION_TYPES); a PERFORMED signature of a step waiting for its incoming
--     performer is made invalid when its data changes (a value another step's correction recomputes), as on a step
--     IN_PROGRESS (engine.ts resignAfterChange).
--
-- Message: EBMR-EXE-185. New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); the
-- trigger function is SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The shared guards (latest bodies: 0311, 0315, 0453, 0382)
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.act_status_before(p_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_type
           when 'START_STEP' then 'ENABLED'
           when 'REQUEST_SKIP' then 'ENABLED'
           when 'DISPOSITION_HOLD_POINT' then 'ENABLED'
           when 'RECORD_DATA' then 'IN_PROGRESS'
           when 'RECORD_ENTRY' then 'IN_PROGRESS'
           when 'VOID_ATTEMPT' then 'IN_PROGRESS'
           when 'SIGN_PERFORMED' then 'IN_PROGRESS'
           when 'VERIFY' then 'AWAITING_VERIFICATION'
           when 'HAND_OVER_STEP' then 'IN_PROGRESS'
           when 'TAKE_OVER_STEP' then 'ATTEMPT_HANDED_OVER'
         end
$$;

create or replace function recipe.step_status_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_done  boolean := p_kind = 'COMMAND' and p_accepted is true;
  v_type  text := case when p_kind = 'COMMAND' then p_command ->> 'type' end;
  v_need  text := case when p_kind = 'COMMAND' and p_accepted is true then recipe.act_status_before(p_command ->> 'type') end;
  v_own   text;
  v_point text;
  v_ok    boolean;
  k       text;
  x       jsonb;
  y       jsonb;
  a       text;
  b       text;
begin
  if jsonb_typeof(p_old -> 'steps') is distinct from 'object' or jsonb_typeof(p_new -> 'steps') is distinct from 'object' then
    return 'stores a state whose steps are malformed';
  end if;
  if v_need is not null then
    if jsonb_typeof(p_command -> 'step') is distinct from 'string' then
      return 'names no step to act on';
    end if;
    v_own := (p_command ->> 'step') || '@' || recipe.ctx_key(coalesce(p_command -> 'context', '[]'::jsonb));
    a := p_old -> 'steps' -> v_own ->> 'status';
    if a is distinct from v_need then
      return format('acts on step %s, which is %s before it; the engine takes a %s only on a step that is %s',
                    v_own, coalesce(lower(replace(a, '_', ' ')), 'not in the state'), v_type, lower(replace(v_need, '_', ' ')));
    end if;
  end if;
  if v_done and v_type = 'INVALIDATE_RESULT' and jsonb_typeof(p_command -> 'point') = 'string' then
    v_point := p_old -> 'points' -> (p_command ->> 'point') ->> 'stepKey';
  end if;
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'steps') e order by e.key loop
    y := p_new -> 'steps' -> k;
    a := x ->> 'status';
    b := y ->> 'status';
    if jsonb_typeof(y) is distinct from 'object' then
      return format('removes step instance %s', k);
    end if;
    continue when a is not distinct from b;
    v_ok := case
      when a = 'ENABLED' and b = 'IN_PROGRESS' then k = v_own and v_type = 'START_STEP'
      when a = 'ENABLED' and b = 'SKIPPED' then k = v_own and v_type = 'REQUEST_SKIP'
      when a = 'ENABLED' and b = 'COMPLETED' then k = v_own and v_type = 'DISPOSITION_HOLD_POINT'
      when a = 'IN_PROGRESS' and b in ('AWAITING_VERIFICATION', 'COMPLETED') then k = v_own and v_type = 'SIGN_PERFORMED'
      when a = 'AWAITING_VERIFICATION' and b = 'COMPLETED' then k = v_own and v_type = 'VERIFY'
      when a = 'COMPLETED' and b = 'AWAITING_VERIFICATION' then v_done and v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT')
      when a in ('COMPLETED', 'AWAITING_VERIFICATION') and b = 'IN_PROGRESS' then k = v_point
      when a = 'IN_PROGRESS' and b = 'ATTEMPT_HANDED_OVER' then k = v_own and v_type = 'HAND_OVER_STEP'
      when a = 'ATTEMPT_HANDED_OVER' and b = 'IN_PROGRESS' then k = v_own and v_type = 'TAKE_OVER_STEP'
      else false
    end;
    if not coalesce(v_ok, false) then
      return format('moves step instance %s from %s to %s; the engine moves a step only along its life cycle, by the act that moves it',
                    k, coalesce(lower(replace(a, '_', ' ')), 'no status'), coalesce(lower(replace(b, '_', ' ')), 'no status'));
    end if;
  end loop;
  return null;
end
$$;

create or replace function recipe.command_step_key(p_type text, p_cmd jsonb, p_points jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when p_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY', 'REQUEST_SKIP', 'DISPOSITION_HOLD_POINT', 'VOID_ATTEMPT', 'RAISE_EXCEPTION',
                      'HAND_OVER_STEP', 'TAKE_OVER_STEP')
         and jsonb_typeof(p_cmd -> 'step') = 'string'
      then (p_cmd ->> 'step') || '@' || recipe.ctx_key(p_cmd -> 'context')
    when p_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT') and jsonb_typeof(p_cmd -> 'point') = 'string'
         and jsonb_typeof(p_points -> (p_cmd ->> 'point') -> 'stepKey') = 'string'
      then p_points -> (p_cmd ->> 'point') ->> 'stepKey'
  end
$$;

create or replace function recipe.execution_state_binding_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := old.state;
  s1        jsonb := new.state;
  r         recipe.execution_command;
  v_cmd     jsonb;
  v_type    text;
  v_key     text;
  v_done    boolean;
  v_content jsonb;
  v_param   jsonb;
  v_n       bigint;
  v_manual  integer := 0;
  v_point   jsonb;
  v_entries integer := 0;
  v_status  text[];
  v_fields  text[] := array['source', 'balance', 'gross', 'tare', 'unit'];
  v_problem text;
  k         text;
  x         jsonb;
  y         jsonb;
  m         text;
  f         text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.seq is null then
    raise exception using errcode = 'P0001', message = format('The state of batch %s names row %s, which does not exist (DI-34). [EBMR-EXE-030]', new.batch_id, new.last_seq);
  end if;
  if r.kind not in ('COMMAND', 'PREPARE') or r.source not in ('UI', 'API') then
    return null;
  end if;
  foreach m in array array['steps', 'points', 'entries'] loop
    if jsonb_typeof(s0 -> m) is distinct from 'object' or jsonb_typeof(s1 -> m) is distinct from 'object' then
      raise exception using errcode = 'P0001', message = format('The %s of the engine state are malformed (DI-34). [EBMR-EXE-030]', m);
    end if;
  end loop;
  v_cmd := case when r.kind = 'PREPARE' then r.command -> 'target' else r.command end;
  v_type := v_cmd ->> 'type';
  v_done := r.kind = 'COMMAND' and r.accepted;
  -- A skip, a void, a hand-over and a take-over act on the step instance they name, like the step commands (0453, 0463).
  v_key := coalesce(recipe.row_step_key(r.kind, r.command),
                    case when v_done and v_type in ('REQUEST_SKIP', 'VOID_ATTEMPT', 'HAND_OVER_STEP', 'TAKE_OVER_STEP') and jsonb_typeof(v_cmd -> 'step') = 'string'
                         then (v_cmd ->> 'step') || '@' || recipe.ctx_key(coalesce(v_cmd -> 'context', '[]'::jsonb)) end);

  -- EBMR-EXE-126: every new data point is what the row records.
  for k, x in select key, value from jsonb_each(s1 -> 'points') where not ((s0 -> 'points') ? key) order by key loop
    m := x -> 'source' ->> 'mode';
    if m = 'MANUAL' and v_done and v_type = 'VOID_ATTEMPT' and x ->> 'kind' = 'ABORTED' and x ->> 'stepKey' = v_key
       and x ->> 'enteredBy' = r.actor_person::text then
      -- The voided attempt of an accepted void, in its own step and in its person's name: no value (0452 holds the rest).
      continue;
    elsif m = 'MANUAL' then
      if not (v_done and v_type in ('RECORD_DATA', 'CORRECT_ENTRY')) then
        raise exception using errcode = 'P0001',
          message = format('Data point %s is a hand entry that this %s %s row does not key: a value keyed by hand is recorded only by the accepted RECORD_DATA (or correction) that carries it (DI-30, DI-32). [EBMR-EXE-126]',
                           k, case when r.accepted then 'accepted' else 'refused' end, coalesce(v_type, r.kind));
      end if;
      v_manual := v_manual + 1;
      v_point := x;
    elsif m = 'BLOCK' then
      if v_type is distinct from 'SIGN_PERFORMED' or x ->> 'stepKey' is distinct from v_key then
        raise exception using errcode = 'P0001',
          message = format('Data point %s is computed by the block of step %s, which is not the step this %s row signs as performed; a block computes its values when its own step is signed performed (DI-33, INV-25). [EBMR-EXE-126]',
                           k, coalesce(x ->> 'stepKey', '(none)'), coalesce(v_type, r.kind));
      end if;
    else
      raise exception using errcode = 'P0001',
        message = format('Data point %s is recorded with a %s source, which no device, scan or system attests for a person''s row in this release: a value a person records is a hand entry (DI-30, DI-32). [EBMR-EXE-126]',
                         k, coalesce(m, 'missing'));
    end if;
  end loop;

  -- EBMR-EXE-126, EBMR-EXE-127: the accepted RECORD_DATA stores exactly the value it keys, with the hand-entry rules.
  if v_done and v_type = 'RECORD_DATA' then
    if v_manual <> 1 then
      raise exception using errcode = 'P0001',
        message = format('The RECORD_DATA of %s stores %s hand-entered values; it stores exactly the one it keys (DI-30, DI-32). [EBMR-EXE-126]', coalesce(v_cmd ->> 'item', '(no item)'), v_manual);
    end if;
    if v_point ->> 'item' is distinct from v_cmd ->> 'item' or v_point ->> 'stepKey' is distinct from v_key
       or v_point -> 'source' is distinct from v_cmd -> 'source' or v_point -> 'value' is distinct from v_cmd -> 'value'
       or v_point ->> 'enteredBy' is distinct from r.actor_person::text or v_point ->> 'kind' is distinct from 'VALUE' then
      raise exception using errcode = 'P0001',
        message = format('The value the state stores for %s is not the one the RECORD_DATA keys: its item, step, value, source or person differ (DI-30, DI-32, DI-14). [EBMR-EXE-126]', coalesce(v_cmd ->> 'item', '(no item)'));
    end if;
    select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
    select count(*), (array_agg(p))[1] into v_n, v_param
      from jsonb_array_elements(case when jsonb_typeof(v_content -> 'parameters') = 'array' then v_content -> 'parameters' else '[]'::jsonb end) p
     where p ->> 'id' = v_cmd ->> 'item';
    if v_n is distinct from 1 then
      raise exception using errcode = 'P0001',
        message = format('%s is not a parameter of the batch''s MBR, so no value of it is recorded (DI-30, DI-34). [EBMR-EXE-126]', coalesce(v_cmd ->> 'item', '(no item)'));
    end if;
    -- The engine flags a value keyed by hand for a parameter the MBR captures otherwise (data.ts storePoint).
    if coalesce(jsonb_typeof(v_point -> 'flags') = 'array' and (v_point -> 'flags') ? 'MANUAL_FALLBACK', false)
       is distinct from (coalesce(v_param ->> 'capture', 'MANUAL') <> 'MANUAL') then
      raise exception using errcode = 'P0001',
        message = format('The value of %s is keyed by hand, and the MBR captures it %s: it is flagged MANUAL_FALLBACK exactly when the MBR captures it otherwise than by hand (DI-30, PR-14). [EBMR-EXE-126]',
                         v_cmd ->> 'item', lower(coalesce(v_param ->> 'capture', 'MANUAL')));
    end if;
    if (coalesce(v_param ->> 'capture', 'MANUAL') <> 'MANUAL' or v_param ->> 'criticality' = 'CRITICAL')
       and (s1 -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
      raise exception using errcode = 'P0001',
        message = format('%s is %s and keyed by hand, so step %s needs a second person''s check before it completes; the state does not require it (DI-30, PR-14). [EBMR-EXE-127]',
                         v_cmd ->> 'item', case when v_param ->> 'criticality' = 'CRITICAL' then 'critical' else 'a manual fallback' end, v_key);
    end if;
  end if;

  -- EBMR-EXE-128, EBMR-EXE-126: a new block entry belongs to the row's own step and person, from its accepted
  -- RECORD_ENTRY (or the start data of its START_STEP), and holds the weighing facts its command sent.
  for k, x in select key, value from jsonb_each(s1 -> 'entries') where not ((s0 -> 'entries') ? key) order by key loop
    v_entries := v_entries + 1;
    if not (v_done and ((v_type = 'RECORD_ENTRY' and x ->> 'kind' = v_cmd -> 'entry' ->> 'kind') or (v_type = 'START_STEP' and x ->> 'kind' = 'START_DATA')))
       or x ->> 'stepKey' is distinct from v_key or x ->> 'enteredBy' is distinct from r.actor_person::text or v_entries > 1 then
      raise exception using errcode = 'P0001',
        message = format('Entry %s (%s of step %s) is not the entry this %s row records: an entry is recorded by the accepted RECORD_ENTRY of its own step, in the name of its person (DI-20, DI-30, DI-14). [EBMR-EXE-128]',
                         k, coalesce(x ->> 'kind', '?'), coalesce(x ->> 'stepKey', '(none)'), coalesce(v_type, r.kind));
    end if;
    -- A weighing (an entry naming its balance; blocks G-07 and G-22) keeps what was weighed on which balance, and how.
    if v_type = 'RECORD_ENTRY' and (v_cmd -> 'entry') ? 'balance' then
      foreach f in array v_fields loop
        if (v_cmd -> 'entry') ? f and (x -> 'data' -> f) is distinct from (v_cmd -> 'entry' -> f) then
          raise exception using errcode = 'P0001',
            message = format('Entry %s stores another %s than its RECORD_ENTRY sent (DI-30, DI-32). [EBMR-EXE-126]', k, f);
        end if;
      end loop;
    end if;
  end loop;
  if v_done and v_type = 'RECORD_ENTRY' and v_entries <> 1 then
    raise exception using errcode = 'P0001',
      message = format('The RECORD_ENTRY of step %s stores %s entries; it stores exactly the one it records (DI-30, DI-34). [EBMR-EXE-128]', coalesce(v_key, '(none)'), v_entries);
  end if;

  -- EBMR-EXE-128, EBMR-EXE-127: the step instances.
  for k, x in select key, value from jsonb_each(s0 -> 'steps') order by key loop
    y := s1 -> 'steps' -> k;
    if y is null then
      raise exception using errcode = 'P0001', message = format('The state no longer holds step instance %s; a step instance is never removed (DI-34). [EBMR-EXE-128]', k);
    end if;
    -- The second person, once required, stays required.
    if (x -> 'verificationRequired') = 'true'::jsonb and (y -> 'verificationRequired') is distinct from 'true'::jsonb then
      raise exception using errcode = 'P0001',
        message = format('Step %s needs a second person''s check, and this %s row clears that requirement; nothing clears it (DI-30, PR-14). [EBMR-EXE-127]', k, coalesce(v_type, r.kind));
    end if;
    if k is not distinct from v_key or y = x then
      continue;
    end if;
    if not (v_done and v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT')) then
      v_problem := case
        when jsonb_typeof(y) is distinct from 'object' or jsonb_typeof(x) is distinct from 'object' then 'it is malformed'
        when (y - array['signatures', 'performedSigners']) is distinct from (x - array['signatures', 'performedSigners'])
          then 'its status, times, persons, targets or values change'
        when jsonb_typeof(y -> 'performedSigners') is distinct from 'array' or not ((y -> 'performedSigners') <@ coalesce(x -> 'performedSigners', '[]'::jsonb))
          then 'a PERFORMED signer is added'
        else recipe.signature_change_problem(x, y, '{}'::uuid[])
      end;
      if v_problem is not null then
        raise exception using errcode = 'P0001',
          message = format('This %s row acts on %s, yet the state changes step %s (%s): a row changes the step it acts on, and otherwise only what the system does on its own (DI-20, DI-34, INV-03). [EBMR-EXE-128]',
                           coalesce(v_type, r.kind), coalesce('step ' || v_key, 'no step'), k, v_problem);
      end if;
    end if;
  end loop;
  for k, y in select key, value from jsonb_each(s1 -> 'steps') where not ((s0 -> 'steps') ? key) order by key loop
    v_problem := recipe.new_instance_problem(k, y);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Step instance %s is new in the state, and %s: a row brings in a step instance only as the system does, enabled or not applicable, with nobody''s involvement (DI-20, DI-34, INV-03). [EBMR-EXE-128]', k, v_problem);
    end if;
  end loop;

  -- The row's own step instance.
  if v_key is not null then
    x := s0 -> 'steps' -> v_key;
    y := s1 -> 'steps' -> v_key;
    v_status := case when not v_done then array[x ->> 'status']
                     when v_type = 'START_STEP' then array['IN_PROGRESS']
                     when v_type in ('RECORD_DATA', 'RECORD_ENTRY') then array[x ->> 'status']
                     when v_type = 'SIGN_PERFORMED' then array['IN_PROGRESS', 'AWAITING_VERIFICATION', 'COMPLETED']
                     when v_type = 'VERIFY' then array['COMPLETED']
                     when v_type = 'REQUEST_SKIP' then array['SKIPPED']
                     when v_type = 'VOID_ATTEMPT' then array[x ->> 'status']
                     when v_type = 'HAND_OVER_STEP' then array['ATTEMPT_HANDED_OVER']
                     when v_type = 'TAKE_OVER_STEP' then array['IN_PROGRESS'] end;
    if v_status is not null and not exists (select 1 from unnest(v_status) a where a is not distinct from y ->> 'status') then
      raise exception using errcode = 'P0001',
        message = format('This %s %s row leaves step %s %s; it %s (DI-34, PR-14). [EBMR-EXE-128]',
                         case when r.kind = 'PREPARE' then 'preparation' when r.accepted then 'accepted' else 'refused' end, coalesce(v_type, r.kind), v_key,
                         coalesce(y ->> 'status', 'without a status'),
                         case when not v_done then 'changes no step''s status' else format('leaves it %s', array_to_string(v_status, ' or ')) end);
    end if;
    if y is not null then
      v_problem := case
        when jsonb_typeof(y -> 'performedSigners') is distinct from 'array'
             or not ((y -> 'performedSigners') <@ (coalesce(x -> 'performedSigners', '[]'::jsonb)
                                                   || case when v_done and v_type = 'SIGN_PERFORMED' then jsonb_build_array(r.actor_person::text) else '[]'::jsonb end))
          then 'a PERFORMED signer is added that did not sign it performed in this row'
        else recipe.signature_change_problem(coalesce(x, '{}'::jsonb), y, case when v_done then r.signature_ids else '{}'::uuid[] end)
      end;
      if v_problem is not null then
        raise exception using errcode = 'P0001',
          message = format('The state of step %s after this %s row does not follow from it: %s (DI-35, INV-10, PR-14). [EBMR-EXE-128]', v_key, coalesce(v_type, r.kind), v_problem);
      end if;
    end if;
    -- A step that needs its check is not completed by its PERFORMED signature.
    if v_done and v_type = 'SIGN_PERFORMED' and y ->> 'status' = 'COMPLETED' then
      if v_content is null then
        select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
      end if;
      if (y -> 'verificationRequired') = 'true'::jsonb or jsonb_typeof(recipe.step_node(v_content, v_cmd ->> 'step') -> 'signatures' -> 'check') = 'object' then
        raise exception using errcode = 'P0001',
          message = format('Step %s needs a second person''s check, so its PERFORMED signature leaves it awaiting verification, not completed (DI-30, PR-14, INV-03). [EBMR-EXE-127]', v_key);
      end if;
    end if;
  end if;
  return null;
end
$$;

create or replace function recipe.step_facts_changed(p_old jsonb, p_new jsonb, p_key text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1
                   from unnest(array['points', 'derived', 'entries']) m (member)
                  cross join lateral (select e.key from jsonb_each(case when jsonb_typeof(p_old -> m.member) = 'object' then p_old -> m.member else '{}'::jsonb end) e
                                      union
                                      select e.key from jsonb_each(case when jsonb_typeof(p_new -> m.member) = 'object' then p_new -> m.member else '{}'::jsonb end) e) r
                  where p_key in (p_old -> m.member -> r.key ->> 'stepKey', p_new -> m.member -> r.key ->> 'stepKey')
                    and (p_new -> m.member -> r.key) is distinct from (p_old -> m.member -> r.key))
      or exists (select 1
                   from (select e.key from jsonb_each(case when jsonb_typeof(p_old -> 'exceptions') = 'object' then p_old -> 'exceptions' else '{}'::jsonb end) e
                         union
                         select e.key from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) e) r
                  where p_key in (p_old -> 'exceptions' -> r.key -> 'source' ->> 'stepKey', p_new -> 'exceptions' -> r.key -> 'source' ->> 'stepKey')
                    and coalesce(p_new -> 'exceptions' -> r.key ->> 'type', p_old -> 'exceptions' -> r.key ->> 'type')
                        not in ('WITNESS_LATE', 'OPERATOR_RAISED', 'HOLD_POINT_NOT_APPROVED', 'STEP_SKIPPED', 'EXECUTED_TARGET_CHANGED', 'STEP_HANDED_OVER')
                    and ((p_new -> 'exceptions' -> r.key) - array['status', 'disposition', 'deviation'])
                        is distinct from ((p_old -> 'exceptions' -> r.key) - array['status', 'disposition', 'deviation']))
$$;

create or replace function recipe.signature_invalidation_problem(p_key text, p_old jsonb, p_new jsonb, p_s0 jsonb, p_s1 jsonb, p_type text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_old     jsonb := case when jsonb_typeof(p_old -> 'signatures') = 'array' then p_old -> 'signatures' else '[]'::jsonb end;
  v_new     jsonb := case when jsonb_typeof(p_new -> 'signatures') = 'array' then p_new -> 'signatures' else '[]'::jsonb end;
  v_was     jsonb := case when jsonb_typeof(p_old -> 'performedSigners') = 'array' then p_old -> 'performedSigners' else '[]'::jsonb end;
  v_now     jsonb := case when jsonb_typeof(p_new -> 'performedSigners') = 'array' then p_new -> 'performedSigners' else '[]'::jsonb end;
  v_status  text := p_new ->> 'status';
  v_correct boolean := coalesce(p_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT'), false);
  -- The engine sends back, or reopens, only a step that was COMPLETED or AWAITING_VERIFICATION (corrections.ts).
  v_back    boolean := coalesce(p_old ->> 'status' in ('COMPLETED', 'AWAITING_VERIFICATION'), false);
  v_changed boolean;
  v_stale   jsonb := '[]'::jsonb;
  o         jsonb;
  x         jsonb;
  s         jsonb;
begin
  for i in 0 .. jsonb_array_length(v_old) - 1 loop
    o := v_old -> i;
    x := v_new -> i;
    if not coalesce((o -> 'valid') = 'true'::jsonb and (x -> 'valid') = 'false'::jsonb, false) then
      continue; -- kept, or changed otherwise: 0300 and 0381 judge that
    end if;
    v_changed := coalesce(v_changed, recipe.step_facts_changed(p_s0, p_s1, p_key));
    if not coalesce(   (o ->> 'role' = 'PERFORMED' and v_status in ('IN_PROGRESS', 'ATTEMPT_HANDED_OVER') and v_changed)
                    or (v_correct and v_back and o ->> 'role' in ('PERFORMED', 'CHECKED') and v_status = 'AWAITING_VERIFICATION' and (p_new -> 'reverification') = 'true'::jsonb)
                    or (p_type = 'INVALIDATE_RESULT' and v_back and o ->> 'role' in ('PERFORMED', 'CHECKED') and v_status = 'IN_PROGRESS' and v_changed), false) then
      return format('its %s signature %s is made invalid with the step left %s%s', coalesce(o ->> 'role', '(no role)'), coalesce(o ->> 'id', '(no id)'),
                    coalesce(v_status, 'without a status'), case when v_changed then '' else ' and none of its data changed' end);
    end if;
    if coalesce(o ->> 'role' = 'PERFORMED' and v_status in ('IN_PROGRESS', 'ATTEMPT_HANDED_OVER'), false) then
      v_stale := v_stale || jsonb_build_array(o -> 'signer');
    end if;
  end loop;
  -- The signer of a PERFORMED signature made invalid on a step left in progress signs again: no longer a PERFORMED
  -- signer, unless the row records a new PERFORMED signature of that person.
  for s in select e from jsonb_array_elements(v_stale) e loop
    if v_now @> jsonb_build_array(s)
       and not exists (select 1 from jsonb_array_elements(v_new) with ordinality n (g, j)
                        where n.j > jsonb_array_length(v_old) and n.g ->> 'role' = 'PERFORMED' and n.g -> 'signer' = s and (n.g -> 'valid') = 'true'::jsonb) then
      return format('the PERFORMED signature of %s is made invalid, and %s stays a PERFORMED signer of it', s #>> '{}', s #>> '{}');
    end if;
  end loop;
  -- A PERFORMED signer leaves only with the PERFORMED signature the row makes invalid (or all of them, when a result
  -- invalidation reopens the step).
  if not coalesce(p_type = 'INVALIDATE_RESULT' and v_back and v_status = 'IN_PROGRESS' and v_now = '[]'::jsonb, false) then
    for s in select e from jsonb_array_elements(v_was) e loop
      if not (v_now @> jsonb_build_array(s)) and not (v_stale @> jsonb_build_array(s)) then
        return format('%s is no longer a PERFORMED signer of it, and no PERFORMED signature of %s is made invalid', s #>> '{}', s #>> '{}');
      end if;
    end loop;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The hand-over rules
-- ---------------------------------------------------------------------------------------------

-- L-07, INV-03: the persons the accepted hand-over rows of batch p_batch on step instance p_key name, before row p_before
-- (every row when NULL): {"outgoing": [...], "incoming": [...], "takers": [...]} (persons who took the step over).
create function recipe.hand_over_persons(p_batch uuid, p_key text, p_before bigint) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object(
    'outgoing', coalesce(jsonb_agg(c.command -> 'outgoing') filter (where c.command_type = 'HAND_OVER_STEP' and jsonb_typeof(c.command -> 'outgoing') = 'string'), '[]'::jsonb),
    'incoming', coalesce(jsonb_agg(c.command -> 'incoming') filter (where c.command_type = 'HAND_OVER_STEP' and jsonb_typeof(c.command -> 'incoming') = 'string'), '[]'::jsonb),
    'takers', coalesce(jsonb_agg(to_jsonb(c.actor_person::text)) filter (where c.command_type = 'TAKE_OVER_STEP' and c.actor_person is not null), '[]'::jsonb),
    'lastIncoming', (array_agg(c.command -> 'incoming' order by c.seq desc) filter (where c.command_type = 'HAND_OVER_STEP'))[1])
    from recipe.execution_command c
   where c.batch_id = p_batch and c.kind = 'COMMAND' and c.accepted and c.command_type in ('HAND_OVER_STEP', 'TAKE_OVER_STEP')
     and (p_before is null or c.seq < p_before)
     and jsonb_typeof(c.command -> 'step') = 'string'
     and (c.command ->> 'step') || '@' || recipe.ctx_key(coalesce(c.command -> 'context', '[]'::jsonb)) = p_key
$$;

-- Whether p is the id of a person of this installation (iam.person).
create function recipe.is_person_id(p jsonb) returns boolean
language sql stable set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce(jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  and exists (select 1 from iam.person x where x.id = (p #>> '{}')::uuid), false)
$$;

-- DI-14, DI-24, DI-26, DI-35, PR-14, INV-03, INV-31 (L-07): why state p_new, stored by row p_seq of batch p_batch (kind
-- p_kind, accepted p_accepted, command p_cmd, person p_person) after state p_old, takes or bypasses a hand-over otherwise
-- than the engine does (header); NULL when it does not. The text completes "This <row> ...".
create function recipe.hand_over_problem(p_batch uuid, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_cmd jsonb, p_person text, p_seq bigint)
returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_done  boolean := p_kind = 'COMMAND' and p_accepted is true;
  v_type  text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_key   text;
  v_pkey  text;
  v_who   jsonb;
  v_inv   jsonb;
  v_ho    jsonb;
  v_ap    jsonb;
  v_n     integer;
  h0      jsonb;
  h1      jsonb;
  hl      jsonb;
  k       text;
  x       jsonb;
  y       jsonb;
  e       jsonb;
begin
  if jsonb_typeof(p_old -> 'steps') is distinct from 'object' or jsonb_typeof(p_new -> 'steps') is distinct from 'object' then
    return null; -- 0300 refuses malformed steps
  end if;
  if p_kind = 'COMMAND' and jsonb_typeof(p_cmd -> 'step') = 'string' then
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(coalesce(p_cmd -> 'context', '[]'::jsonb));
  end if;
  v_who := to_jsonb(p_person);

  -- Every row: a step's hand-over record changes only by its own hand-over (one more) or take-over (marked taken over).
  for k, x in select s.key, s.value from jsonb_each(p_old -> 'steps') s order by s.key loop
    y := p_new -> 'steps' -> k;
    h0 := coalesce(x -> 'handOvers', '[]'::jsonb);
    h1 := coalesce(y -> 'handOvers', '[]'::jsonb);
    continue when h1 = h0 or y is null;
    if jsonb_typeof(h0) is distinct from 'array' or jsonb_typeof(h1) is distinct from 'array' then
      return format('stores a malformed hand-over record of step %s', k);
    end if;
    if v_type = 'HAND_OVER_STEP' and k = v_key and jsonb_array_length(h1) = jsonb_array_length(h0) + 1
       and (h1 - (jsonb_array_length(h1) - 1)) = h0 then
      continue;
    end if;
    if v_type = 'TAKE_OVER_STEP' and k = v_key and jsonb_array_length(h1) = jsonb_array_length(h0) and jsonb_array_length(h0) > 0
       and (h1 - (jsonb_array_length(h1) - 1)) = (h0 - (jsonb_array_length(h0) - 1))
       and not ((h0 -> -1) ? 'takenOverAt') and (h1 -> -1) ? 'takenOverAt' and ((h1 -> -1) - 'takenOverAt') = (h0 -> -1) then
      continue;
    end if;
    return format('changes the hand-over record of step %s; only that step''s own accepted hand-over adds one, and its take-over marks it taken over', k);
  end loop;
  for k, y in select s.key, s.value from jsonb_each(p_new -> 'steps') s where not ((p_old -> 'steps') ? s.key) order by s.key loop
    if y ? 'handOvers' then
      return format('brings in step instance %s with a hand-over record', k);
    end if;
  end loop;

  -- Every row: a STEP_HANDED_OVER exception is raised only by an accepted HAND_OVER_STEP, exactly one, at its step, by its person.
  v_n := 0;
  for k, e in select s.key, s.value from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) s
               where not coalesce((p_old -> 'exceptions') ? s.key, false) and s.value ->> 'type' = 'STEP_HANDED_OVER' order by s.key loop
    v_n := v_n + 1;
    if v_type is distinct from 'HAND_OVER_STEP' then
      return format('raises exception %s (STEP_HANDED_OVER); only an accepted hand-over raises one', k);
    end if;
    if e -> 'source' ->> 'stepKey' is distinct from v_key or e ->> 'raisedBy' is distinct from p_person then
      return format('raises exception %s (STEP_HANDED_OVER) at %s by %s; a hand-over raises it at its own step, by the supervisor who records it',
                    k, coalesce(e -> 'source' ->> 'stepKey', 'no step'), coalesce(e ->> 'raisedBy', 'nobody'));
    end if;
  end loop;
  if v_type = 'HAND_OVER_STEP' and v_n <> 1 then
    return format('raises %s STEP_HANDED_OVER exceptions; a hand-over raises exactly one, so it stands in the exception register', v_n);
  end if;

  if not v_done then
    return null;
  end if;

  -- A correction or an invalidation waits until the incoming performer has taken the step over.
  if v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT') and jsonb_typeof(p_cmd -> 'point') = 'string' then
    v_pkey := p_old -> 'points' -> (p_cmd ->> 'point') ->> 'stepKey';
    if p_old -> 'steps' -> v_pkey ->> 'status' = 'ATTEMPT_HANDED_OVER' then
      return format('changes data of step %s while it waits for the incoming performer of its hand-over', v_pkey);
    end if;
    return null;
  end if;
  if v_key is null then
    return null;
  end if;
  v_ho := recipe.hand_over_persons(p_batch, v_key, p_seq);

  -- A performer who handed the step over no longer acts in it.
  if v_type in ('RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VOID_ATTEMPT', 'START_STEP') and (v_ho -> 'outgoing') @> jsonb_build_array(v_who) then
    return format('is %s''s act in step %s, which they handed over; the performer who took it over completes it', p_person, v_key);
  end if;

  -- INV-03, INV-31, PR-14: the verifier is none of the persons involved, from the rows and the hand-overs.
  if v_type = 'VERIFY' then
    if recipe.recorded_involvement(p_batch, p_old -> 'points', v_key, p_seq) @> jsonb_build_array(v_who)
       or (v_ho -> 'outgoing') @> jsonb_build_array(v_who) or (v_ho -> 'incoming') @> jsonb_build_array(v_who) or (v_ho -> 'takers') @> jsonb_build_array(v_who) then
      return format('verifies step %s by %s, who performed, entered data in or corrected it, or handed it over or took it over; the verifier is always another person', v_key, p_person);
    end if;
    return null;
  end if;

  x := p_old -> 'steps' -> v_key;
  y := p_new -> 'steps' -> v_key;
  if v_type = 'TAKE_OVER_STEP' then
    if (v_ho -> 'lastIncoming') is distinct from v_who or (x -> 'handOvers' -> -1 -> 'incoming') is distinct from v_who then
      return format('takes step %s over by %s, whom its last hand-over does not name as the incoming performer', v_key, p_person);
    end if;
    if not coalesce((y -> 'performers') @> jsonb_build_array(v_who)
                    and (y -> 'performers') <@ (coalesce(x -> 'performers', '[]'::jsonb) || jsonb_build_array(v_who))
                    and (y - array['status', 'handOvers', 'performers']) = (x - array['status', 'handOvers', 'performers']), false) then
      return format('changes step %s otherwise than a take-over does (the incoming performer added to its performers, the hand-over marked taken over)', v_key);
    end if;
    return null;
  end if;
  if v_type is distinct from 'HAND_OVER_STEP' then
    return null;
  end if;

  if recipe.member_blank(p_cmd -> 'reason') then
    return 'has a blank reason';
  end if;
  v_inv := recipe.step_involvement(x) || recipe.recorded_involvement(p_batch, p_old -> 'points', v_key, p_seq) || (v_ho -> 'takers');
  if not recipe.is_person_id(p_cmd -> 'outgoing') or not (v_inv @> jsonb_build_array(p_cmd -> 'outgoing')) or (v_ho -> 'outgoing') @> jsonb_build_array(p_cmd -> 'outgoing') then
    return format('hands step %s over from %s, who is not a performer of it still on it', v_key, left(coalesce(p_cmd ->> 'outgoing', 'nobody'), 64));
  end if;
  if not recipe.is_person_id(p_cmd -> 'incoming') or (p_cmd -> 'incoming') = (p_cmd -> 'outgoing') or (v_ho -> 'outgoing') @> jsonb_build_array(p_cmd -> 'incoming') then
    return format('hands step %s over to %s, who is not another person of this installation or handed the step over before', v_key, left(coalesce(p_cmd ->> 'incoming', 'nobody'), 64));
  end if;
  v_ap := p_cmd -> 'approval' -> 'approver' -> 'id';
  if v_who in (p_cmd -> 'outgoing', p_cmd -> 'incoming') or v_ap in (p_cmd -> 'outgoing', p_cmd -> 'incoming')
     or v_inv @> jsonb_build_array(v_who) or v_inv @> jsonb_build_array(v_ap) then
    return format('is signed or approved by a performer of step %s or a person its hand-over names; the supervisor and QA who approve a hand-over are neither', v_key);
  end if;
  hl := y -> 'handOvers' -> -1;
  if (y -> 'verificationRequired') is distinct from 'true'::jsonb
     or (y - array['status', 'handOvers', 'verificationRequired']) is distinct from (x - array['status', 'handOvers', 'verificationRequired'])
     or jsonb_typeof(hl) is distinct from 'object' or hl ? 'takenOverAt'
     or hl -> 'outgoing' is distinct from p_cmd -> 'outgoing' or hl -> 'incoming' is distinct from p_cmd -> 'incoming'
     or hl -> 'reason' is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason'))
     or hl -> 'supervisor' is distinct from v_who or hl -> 'supervisorSignature' is distinct from p_cmd -> 'signature' -> 'id'
     or hl -> 'qaApprover' is distinct from v_ap or hl -> 'qaSignature' is distinct from p_cmd -> 'approval' -> 'signature' -> 'id' then
    return format('leaves step %s otherwise than the hand-over the command records (the outgoing and incoming performers, the reason, the supervisor and QA with their signatures, the second person''s check required, nothing else changed)', v_key);
  end if;
  return null;
end
$$;

-- The rules of recipe.hand_over_problem on every row (header). EBMR-EXE-185. Raises; returns nothing.
create function recipe.execution_hand_over_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := recipe.hand_over_problem(new.batch_id, old.state, new.state, r.kind, r.accepted, r.command, r.actor_person::text, r.seq);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: it %s. A step in progress is handed over only by a supervisor and QA, neither of them the outgoing or incoming performer, with a reason; the incoming performer takes it over and signs for their own entries; the outgoing performer''s entries stay theirs; the verifier is none of them (PR-14, INV-03, DI-14, DI-24). [EBMR-EXE-185]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zzo_execution_hand_over after update on recipe.execution_state
  for each row execute function recipe.execution_hand_over_check();

revoke all on function recipe.hand_over_persons(uuid, text, bigint), recipe.is_person_id(jsonb),
                       recipe.hand_over_problem(uuid, jsonb, jsonb, text, boolean, jsonb, text, bigint), recipe.execution_hand_over_check() from public;

reset role;
