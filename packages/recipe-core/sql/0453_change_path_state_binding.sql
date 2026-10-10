-- Recipe core, execution store (module C3): the change paths of a test run, part 4: the state a person's row stores
-- (Phase 3 slice 2, plan item 2; DI-24, DI-29, DI-30, DI-34; ADR 0012).
--
-- recipe.execution_state_binding_check (0300) knew the change paths only as refused commands (EBMR-EXE-003): it
-- refused the voided attempt an accepted VOID_ATTEMPT adds (a point "keyed by hand" by no RECORD_DATA), the skip of the
-- step an accepted REQUEST_SKIP names ("acts on no step") and the changes an accepted INVALIDATE_RESULT makes to the
-- steps whose values depend on the invalidated one (the engine's propagation, as for a correction). It now:
--   * takes the step a REQUEST_SKIP or VOID_ATTEMPT names as the step the row acts on;
--   * accepts, as the one new data point of an accepted VOID_ATTEMPT, the voided attempt (kind ABORTED, source MANUAL)
--     of that step in the requester's name (recipe.change_path_problem, 0452, holds its item, reason and that it is the
--     only one);
--   * lets an accepted INVALIDATE_RESULT re-open or send back the steps it reaches, as an accepted CORRECT_ENTRY does
--     (0303, 0311 and 0382 hold how);
--   * leaves the step of an accepted REQUEST_SKIP SKIPPED (with the approval's signature, which the row carries) and
--     the step of an accepted VOID_ATTEMPT in its status.
-- Everything else of 0300 is unchanged. CREATE OR REPLACE keeps the owner, privileges, SECURITY DEFINER and search_path.

set local role ebmr_owner;

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
  -- A skip and a void act on the step instance they name, like the step commands (0453).
  v_key := coalesce(recipe.row_step_key(r.kind, r.command),
                    case when v_done and v_type in ('REQUEST_SKIP', 'VOID_ATTEMPT') and jsonb_typeof(v_cmd -> 'step') = 'string'
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
                     when v_type = 'VOID_ATTEMPT' then array[x ->> 'status'] end;
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

reset role;
