-- Recipe core, execution store (module C3): the state a person's row stores is bound to the command the row records,
-- and the room check of 0285 fails closed (review findings P34, P58 and P36, round-1 verification; DI-20, DI-30,
-- DI-32, PR-14, INV-03; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- 0285 checks the COMMAND row alone: a person's RECORD_DATA must carry the plain source {"mode": "MANUAL"}, and a step
-- command must come from a terminal of the step's room. The round-1 verification found four residuals:
--   (a) the state is written beside the command, not derived from it here. A writer with the application role could
--       store, under a command whose source is MANUAL, the state the engine computes for a SCAN source (a point with
--       source SCAN, no MANUAL_FALLBACK flag, verificationRequired false), and one person could then complete a
--       critical step; only the replay noticed. Likewise a state that changes another step than the one the command
--       names escapes the room check, which reads the command's step only;
--   (b) recipe.step_room_problem returned NULL for a missing or unknown step, so an accepted START_STEP without a
--       step, or naming no step of the MBR, passed from any terminal (fail open);
--   (c) EBMR-EXE-124 accepted a device entry naming any instrument of the room, whatever its status (a BLOCKED
--       balance), and never asked whether a reading was claimed for it (the readings check is the tablets
--       edition's, apps/tablets-server sql 0300);
--   (d) the room check also refused the refused COMMAND row a signing dry run records for a VERIFY or SIGN_PERFORMED
--       sent from another room, so the engine's refusal was neither recorded nor shown.
--
-- This migration:
--   1. makes recipe.step_room_problem fail closed: a missing step, or one the MBR does not hold (recipe.step_node,
--      0270), is a problem;
--   2. replaces the COMMAND row check (recipe.execution_source_room_check, trigger ab_execution_source_room):
--        EBMR-EXE-121, 122  as in 0285, on every person's RECORD_DATA row, accepted or refused;
--        EBMR-EXE-125       an accepted START_STEP, RECORD_DATA, RECORD_ENTRY, SIGN_PERFORMED or VERIFY names no step
--                           of the batch's MBR (checked before the room, so the refusal says what is wrong);
--        EBMR-EXE-123       as in 0285, on accepted rows only: a refused row changes nothing, and the engine's
--                           refusal stays part of the record;
--        EBMR-EXE-124       a device entry (source DEVICE) names, as its balance, an instrument that is registered to
--                           the terminal's room and ACTIVE; on every row, accepted or refused (the server claims the
--                           readings before the engine runs, so a refused entry has them too);
--   3. adds a row trigger on recipe.execution_state (zb_execution_state_binding, after the projection is written;
--      recipe.write_row writes the row and its events first, and the state names that row as last_seq) that compares
--      the state before and after a person's row (COMMAND or PREPARE, source UI or API):
--        EBMR-EXE-126  the values the state adds are the ones the row records: a new data point is a hand entry only
--                      in the accepted RECORD_DATA that keys it (exactly one, with the command's item, step instance,
--                      value, source and person, of a parameter of the MBR, flagged MANUAL_FALLBACK exactly when the
--                      MBR captures the parameter otherwise than by hand) or in an accepted CORRECT_ENTRY; a value
--                      computed by the block (source BLOCK) only when its own step is signed performed; no other source
--                      (DEVICE, SCAN, AUTOMATION, LIMS) is attested for a person's row in this release. A new
--                      weighing entry holds the facts (source, balance, gross, tare, unit) its command sent;
--        EBMR-EXE-127  the second person stays required: a critical value keyed by hand, and a manual fallback, leave
--                      the step needing its check (verificationRequired); nothing clears that flag; an accepted
--                      SIGN_PERFORMED does not complete a step that needs its check (the flag, or a check signature in
--                      the MBR);
--        EBMR-EXE-128  a row changes the step instance it acts on (the step command's own step, the hold point it
--                      decides, a PREPARE row's target) and, besides, only what the system does on its own: a step
--                      instance the token advance enables or sets not applicable, with nobody's involvement, and the
--                      invalidation of a PERFORMED signature whose data changed. On its own step: START_STEP starts it,
--                      RECORD_DATA and RECORD_ENTRY leave its status, VERIFY completes it, a refused row or a PREPARE row
--                      leaves its status; a signature recorded stays as recorded (only made invalid); a new one is an
--                      e-signature the row carries; a PERFORMED signer is added only by an accepted SIGN_PERFORMED of
--                      that person. A new block entry belongs to the row's own step and person, from its accepted
--                      RECORD_ENTRY (or the start data of its START_STEP). An accepted CORRECT_ENTRY may re-open the
--                      steps whose values depend on the corrected one (re-verification), so it is not held to the
--                      first rule.
-- The checks work on the facts the state records; the database does not re-run the engine (the replay verification,
-- ADR 0010, compares every row with the engine). The SWEEP row is the sweeper's (0280, 0299).
--
-- Owner, SECURITY DEFINER and search_path of the replaced functions are kept (CREATE OR REPLACE by the same owner),
-- and so are their privileges (none for PUBLIC). The new helpers and the trigger function are private to the owner.
-- The index on the correlation id serves the tablets edition's check that a claimed reading backs one entry only.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The room of a step, fail closed
-- ---------------------------------------------------------------------------------------------

-- The problem with recording step `p_step` from room `p_room`, or null when there is none. A missing step, or one the
-- MBR content does not hold (recipe.step_node: a phase or a hold point, library calls expanded), is a problem. The
-- rooms are those of every stage of the MBR content that encloses the step: its phase, hold point or, for a step
-- inlined from a library element (expanded id "<call>/<inner>"), the library call it comes from. A stage that names no
-- room sets no room. Two enclosing stages (not a valid MBR) must both admit the room.
create or replace function recipe.step_room_problem(p_content jsonb, p_step text, p_room text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_node  text := split_part(coalesce(p_step, ''), '/', 1);
  s       jsonb;
  v_rooms text[];
begin
  if recipe.step_node(p_content, p_step) is null then
    return format('the MBR of the batch has no step %s', coalesce(nullif(p_step, ''), '(the command names none)'));
  end if;
  for s in select x from jsonb_path_query(p_content -> 'procedure', 'strict $.** ? (@.kind == "stage")') x loop
    if not jsonb_path_exists(s -> 'body', 'strict $.** ? (@.id == $id && (@.kind == "phase" || @.kind == "holdPoint" || @.kind == "libraryCall"))',
                             jsonb_build_object('id', v_node)) then
      continue;
    end if;
    select coalesce(array_agg(r order by r), '{}') into v_rooms
      from jsonb_array_elements_text(case when jsonb_typeof(s -> 'binding' -> 'rooms') = 'array' then s -> 'binding' -> 'rooms' else '[]'::jsonb end) r;
    if cardinality(v_rooms) > 0 and (p_room is null or not (p_room = any (v_rooms))) then
      return format('step %s belongs to stage %s, which is bound to %s; the terminal is %s',
                    p_step, s ->> 'id', array_to_string(v_rooms, ', '), coalesce('in room ' || p_room, 'registered to no room'));
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The COMMAND row
-- ---------------------------------------------------------------------------------------------

-- Refuses a person's step row with a value source the database cannot attest (DI-30, DI-32), an accepted step command
-- naming no step of the MBR or sent from a terminal outside the step's room (DI-20), and a device entry whose balance
-- is not an active instrument of the terminal's room (DI-20, DI-32). Raises; never changes the row (its hash is
-- computed before the insert).
create or replace function recipe.execution_source_room_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_src     jsonb;
  v_content jsonb;
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.source not in ('UI', 'API') then
    return new;
  end if;
  if new.command_type = 'RECORD_DATA' then
    v_src := new.command -> 'source';
    if jsonb_typeof(v_src) is distinct from 'object' or v_src ->> 'mode' is distinct from 'MANUAL' then
      raise exception using errcode = 'P0001',
        message = format('A value a person records is a hand entry: the %s source is not attested by any device the database knows, so it is not recorded as objective evidence (DI-30, DI-32). [EBMR-EXE-121]',
                         coalesce(v_src ->> 'mode', 'missing'));
    end if;
    if v_src <> '{"mode": "MANUAL"}'::jsonb then
      raise exception using errcode = 'P0001',
        message = 'A hand entry carries no attachment hash: no attachment the database stored stands behind it, so it is not evidence of the value (DI-30, DI-32). [EBMR-EXE-122]';
    end if;
  end if;
  -- A refused row changes nothing: the engine's refusal is recorded whatever the terminal (P36, residual d).
  if new.accepted and new.command_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY') then
    select pk.content into v_content
      from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash
     where b.id = new.batch_id;
    if jsonb_typeof(new.command -> 'step') is distinct from 'string' or recipe.step_node(v_content, new.command ->> 'step') is null then
      raise exception using errcode = 'P0001',
        message = format('A step command is recorded only for a step of the batch''s MBR; %s (DI-20, DI-34). [EBMR-EXE-125]',
                         case when jsonb_typeof(new.command -> 'step') = 'string' then format('the MBR has no step %s', new.command ->> 'step')
                              else 'this one names no step' end);
    end if;
    v_problem := recipe.step_room_problem(v_content, new.command ->> 'step', new.room_code);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('The data of a step is accepted only from a terminal of the step''s room: %s (DI-20). [EBMR-EXE-123]', v_problem);
    end if;
  end if;
  if new.command_type = 'RECORD_ENTRY' and new.command -> 'entry' ->> 'source' = 'DEVICE'
     and not exists (select 1 from iam.device d
                      where d.code = new.command -> 'entry' ->> 'balance' and d.device_class = 'INSTRUMENT' and d.status = 'ACTIVE'
                        and new.room_code is not null and d.room_code = new.room_code) then
    raise exception using errcode = 'P0001',
      message = format('A value captured from a device is accepted only from an active instrument of the terminal''s room: %s is not an active instrument registered to %s (DI-20, DI-32). [EBMR-EXE-124]',
                       coalesce(new.command -> 'entry' ->> 'balance', 'no device'), coalesce('room ' || new.room_code, 'a terminal registered to no room'));
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The state a person's row stores
-- ---------------------------------------------------------------------------------------------

-- The key (step@context) of the step instance a row acts on: the step of a step command or of a hold-point decision
-- (a PREPARE row: of its target). NULL for any other row, also for an exception raised about a step (it reports, it
-- does not act on the step).
create function recipe.row_step_key(p_kind text, p_command jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when t ->> 'type' in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT')
                   and jsonb_typeof(t -> 'step') = 'string'
              then (t ->> 'step') || '@' || recipe.ctx_key(coalesce(t -> 'context', '[]'::jsonb)) end
    from (select case when p_kind = 'PREPARE' then p_command -> 'target' else p_command end as t) q
$$;

-- Why step instance p_inst (key p_key), new in the state, is not one the system created by itself (the token advance
-- enabling it, or an untaken branch setting it not applicable, engine advance.ts newInstance); NULL when it is.
create function recipe.new_instance_problem(p_key text, p_inst jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when jsonb_typeof(p_inst) is distinct from 'object' or p_inst ->> 'key' is distinct from p_key then 'it is malformed'
    when coalesce(p_inst ->> 'status', '') not in ('ENABLED', 'NOT_APPLICABLE')
      then format('it appears %s, not as a step the token enables or an untaken branch sets not applicable', coalesce(p_inst ->> 'status', 'without a status'))
    when (p_inst - array['key', 'step', 'kind', 'frames', 'status', 'enabledAt', 'enabledSeq', 'notApplicable', 'firstCompletedSeq'])
         is distinct from '{"performers": [], "dataEnterers": [], "correctors": [], "performedSigners": [], "signatures": [],
                            "verificationRequired": false, "reverification": false, "targets": {}, "blockComputed": {}}'::jsonb
      then 'it appears with a start, an end, a person, a signature, targets or values'
  end
$$;

-- Why the signatures of step instance p_new differ from those of p_old otherwise than the engine changes them; NULL when
-- they do not. A signature the step recorded stays as recorded, except that it is made invalid (valid true -> false)
-- when the data it covered changes; a new signature is appended only with an e-signature the row carries (p_sigs).
create function recipe.signature_change_problem(p_old jsonb, p_new jsonb, p_sigs uuid[]) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_old jsonb := case when jsonb_typeof(p_old -> 'signatures') = 'array' then p_old -> 'signatures' else '[]'::jsonb end;
  v_new jsonb := p_new -> 'signatures';
  o     jsonb;
  x     jsonb;
begin
  if jsonb_typeof(v_new) is distinct from 'array' or jsonb_array_length(v_new) < jsonb_array_length(v_old) then
    return 'a signature it recorded is gone';
  end if;
  for i in 0 .. jsonb_array_length(v_old) - 1 loop
    o := v_old -> i;
    x := v_new -> i;
    if jsonb_typeof(o) is distinct from 'object' or jsonb_typeof(x) is distinct from 'object' then
      return 'a signature it records is malformed';
    end if;
    if (x - 'valid') is distinct from (o - 'valid')
       or ((x -> 'valid') is distinct from (o -> 'valid') and not ((o -> 'valid') = 'true'::jsonb and (x -> 'valid') = 'false'::jsonb)) then
      return format('signature %s it recorded is changed, or made valid again', coalesce(o ->> 'id', '(no id)'));
    end if;
  end loop;
  for i in jsonb_array_length(v_old) .. jsonb_array_length(v_new) - 1 loop
    x := v_new -> i;
    if not coalesce((x ->> 'id') = any (p_sigs::text[]), false) then
      return format('signature %s is not an e-signature this row carries', coalesce(x ->> 'id', '(no id)'));
    end if;
  end loop;
  return null;
end
$$;

-- DI-30, DI-32, PR-14, INV-03, DI-20: the state a person's row (COMMAND or PREPARE, source UI or API) stores is the one
-- its command can have produced (header 3). Runs after the projection is written; the row that produced the state is
-- the one it names (last_seq). Raises; returns nothing.
create function recipe.execution_state_binding_check() returns trigger
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
  v_key := recipe.row_step_key(r.kind, r.command);
  v_done := r.kind = 'COMMAND' and r.accepted;

  -- EBMR-EXE-126: every new data point is what the row records.
  for k, x in select key, value from jsonb_each(s1 -> 'points') where not ((s0 -> 'points') ? key) order by key loop
    m := x -> 'source' ->> 'mode';
    if m = 'MANUAL' then
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
    if not (v_done and v_type = 'CORRECT_ENTRY') then
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
                     when v_type = 'VERIFY' then array['COMPLETED'] end;
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

create trigger zb_execution_state_binding after update on recipe.execution_state
  for each row execute function recipe.execution_state_binding_check();

-- The rows of one command (the tablets edition checks that a claimed reading backs one entry only).
create index execution_command_correlation on recipe.execution_command (correlation_id);

revoke all on function recipe.row_step_key(text, jsonb), recipe.new_instance_problem(text, jsonb),
                       recipe.signature_change_problem(jsonb, jsonb, uuid[]), recipe.execution_state_binding_check() from public;

reset role;
