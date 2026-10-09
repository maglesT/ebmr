-- Recipe core, execution store: the database refuses a person's step row whose value source it cannot attest or
-- whose terminal is outside the step's room (review findings P34, P58 and P36; DI-20, DI-30, DI-32, PR-14).
--
-- P34/P58. The browser could send RECORD_DATA with a SCAN source for any parameter, and the server copied it into
-- the engine command. The engine applies the hand-entry rules (the MANUAL_FALLBACK flag and exception, the second
-- person for a critical value keyed by hand) only to a MANUAL source, so a typed value became "scanned" objective
-- evidence and one person could complete the step. A photo or printout hash that names no stored attachment was
-- accepted the same way. The server now records a value a person sends as a plain MANUAL entry (a scan made on the
-- terminal is not attested by any device proof, and no attachment store exists yet). This migration makes the
-- database refuse anything else: a COMMAND row of a person (source UI or API) of type RECORD_DATA must carry the
-- source {"mode": "MANUAL"} and nothing more.
--   EBMR-EXE-121  the source mode is not MANUAL (SCAN, DEVICE, AUTOMATION, LIMS, BLOCK or none);
--   EBMR-EXE-122  the MANUAL source carries an attachment or any other member.
--
-- P36. Nothing compared the stage binding of a step with the terminal a command came from: a DISP-1 weighing could
-- be recorded from the BLEND-1 kiosk with the BLEND-1 balance, and the DISP-1 clearance from an office PC. DI-20
-- accepts the data of a step whose MBR declares a binding only from a device of the step's location (stricter than
-- the plan's "kiosk's room"). A person's COMMAND row of type START_STEP, RECORD_DATA, RECORD_ENTRY, SIGN_PERFORMED or
-- VERIFY on a step whose enclosing stage names rooms must come from a session whose terminal is registered to one
-- of them; the room is the session's (recipe.execution_actor reads it from iam.session), never the server's word.
--   EBMR-EXE-123  the terminal is in another room, or in none.
-- Raising an exception, linking a deviation, holds, hold-point decisions, stage sign-offs and exception
-- dispositions stay open to any room: they report or decide, they do not record the step's data.
-- A block entry the server marks as captured from a device (source DEVICE: a container weighing, an output
-- container) must name, as its balance, an instrument registered to the terminal's own room. The readings are
-- claimed for a room the server names (tab.claim_readings); this check does not take the server's word for it.
--   EBMR-EXE-124  the entry's device is not an instrument of the terminal's room.
--
-- A BEFORE INSERT trigger on recipe.execution_command is used so that the writers of 0210 (and their later
-- replacements) stay as they are: every row, however it is written, passes through it. Time sweeps, PREPARE rows
-- and the ISSUE row are not a person's step data and are left alone.

set local role ebmr_owner;

-- The problem with recording step `p_step` from room `p_room`, or null when there is none. The rooms are those of
-- every stage of the MBR content that encloses the step: its phase, hold point or, for a step inlined from a
-- library element (expanded id "<call>/<inner>"), the library call it comes from. A step no stage encloses, or a
-- stage that names no room, sets no room. Two enclosing stages (not a valid MBR) must both admit the room.
create function recipe.step_room_problem(p_content jsonb, p_step text, p_room text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_node  text := split_part(coalesce(p_step, ''), '/', 1);
  s       jsonb;
  v_rooms text[];
begin
  if v_node = '' or jsonb_typeof(p_content -> 'procedure') is distinct from 'object' then
    return null;
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

-- Refuses a person's step row with a value source the database cannot attest (DI-30, DI-32) or from a terminal
-- outside the step's room (DI-20). Raises; never changes the row (its hash is computed before the insert).
create function recipe.execution_source_room_check() returns trigger
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
  if new.command_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY') then
    select pk.content into v_content
      from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash
     where b.id = new.batch_id;
    v_problem := recipe.step_room_problem(v_content, new.command ->> 'step', new.room_code);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('The data of a step is accepted only from a terminal of the step''s room: %s (DI-20). [EBMR-EXE-123]', v_problem);
    end if;
  end if;
  if new.command_type = 'RECORD_ENTRY' and new.command -> 'entry' ->> 'source' = 'DEVICE'
     and not exists (select 1 from iam.device d
                      where d.code = new.command -> 'entry' ->> 'balance' and d.device_class = 'INSTRUMENT'
                        and new.room_code is not null and d.room_code = new.room_code) then
    raise exception using errcode = 'P0001',
      message = format('A value captured from a device is accepted only from an instrument of the terminal''s room: %s is not an instrument registered to %s (DI-20, DI-32). [EBMR-EXE-124]',
                       coalesce(new.command -> 'entry' ->> 'balance', 'no device'), coalesce('room ' || new.room_code, 'a terminal registered to no room'));
  end if;
  return new;
end
$$;

create trigger ab_execution_source_room before insert on recipe.execution_command
  for each row execute function recipe.execution_source_room_check();

revoke all on function recipe.step_room_problem(jsonb, text, text), recipe.execution_source_room_check() from public;

reset role;
