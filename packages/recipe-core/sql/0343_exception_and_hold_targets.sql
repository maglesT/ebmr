-- Recipe core, execution store (module C3): an accepted deviation link names an exception of the record and links it,
-- and an accepted hold release names a hold of the record and releases it (Phase 2 exit review F12, round 9
-- self-review; DI-05, DI-30, PR-49, PR-45; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- What was wrong. 0338 binds what an accepted command names as a place to the record (a step instance, a stage frame, a
-- decision; a preparation's target), 0339 the records a row brings in; a disposition and a correction name their
-- exception or data point under the e-signature that covers it (0297). Two accepted commands name a record with nothing
-- behind the name: ATTACH_DEVIATION its exception and RELEASE_HOLD its hold. 0305 lets an exception's deviation link
-- change only through the accepted ATTACH_DEVIATION of that exception, and 0303 keeps a recorded hold as it is, but
-- neither asks that an accepted command of these types change anything. Through the application role an accepted
-- ATTACH_DEVIATION of exception 'L2409-0017' and an accepted RELEASE_HOLD of hold 'L2409-0017', each stored with the
-- state the engine gives (its refusal leaves the state as the time sweep changes it), were recorded 'ok' with no
-- violation; only the release gate's replay (REPLAY-GATE.1) would have told the accepted flag apart.
--
-- What changed (trigger zzk_execution_act_target, after insert or update of recipe.execution_state, every row, after
-- 0339's zzj_execution_state_records; it reads the row the state was written by; recipe.act_target_problem;
-- EBMR-EXE-126), as the engine accepts these commands (engine batch.ts attachDeviation, releaseHold):
--   * an accepted ATTACH_DEVIATION names an exception of the state before the row that was open and had no deviation
--     linked, and the state after the row links one to it (0305 binds that link to this command's reference);
--   * an accepted RELEASE_HOLD names a hold of the state before the row that was not released, and the state after the
--     row records it released.
-- A refused command keeps what was sent (decision F12.5).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05, DI-30, PR-49, PR-45: why accepted command p_command, whose row moves the state from p_before to p_after, names
-- an exception or a hold the record does not have, or does not make the change its type records; NULL when it does (or
-- names none).
create function recipe.act_target_problem(p_before jsonb, p_after jsonb, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_type text := case when jsonb_typeof(p_command) = 'object' then p_command ->> 'type' end;
  k      text;
  x0     jsonb;
  x1     jsonb;
begin
  if v_type = 'ATTACH_DEVIATION' then
    k := case when jsonb_typeof(p_command -> 'exception') = 'string' then p_command ->> 'exception' end;
    x0 := p_before -> 'exceptions' -> k;
    x1 := p_after -> 'exceptions' -> k;
    if k is null or jsonb_typeof(x0) is distinct from 'object' or x0 ->> 'status' is distinct from 'OPEN'
       or coalesce(x0 -> 'deviation', 'null'::jsonb) <> 'null'::jsonb or jsonb_typeof(x1 -> 'deviation') is distinct from 'object' then
      return format('command.exception "%s" is not an exception of the state before the row, open and without a deviation, that the row links to one',
                    left(coalesce(k, 'none'), 64));
    end if;
  elsif v_type = 'RELEASE_HOLD' then
    k := case when jsonb_typeof(p_command -> 'hold') = 'string' then p_command ->> 'hold' end;
    x0 := p_before -> 'holds' -> k;
    x1 := p_after -> 'holds' -> k;
    if k is null or jsonb_typeof(x0) is distinct from 'object' or coalesce(x0 -> 'released', 'null'::jsonb) <> 'null'::jsonb
       or jsonb_typeof(x1 -> 'released') is distinct from 'object' then
      return format('command.hold "%s" is not a hold of the state before the row, not yet released, that the row releases', left(coalesce(k, 'none'), 64));
    end if;
  end if;
  return null;
end
$$;

-- DI-05, DI-30: an accepted deviation link or hold release names a record of the state and changes it (header).
-- EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_act_target_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  if tg_op <> 'UPDATE' then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind is distinct from 'COMMAND' or r.accepted is not true then
    return null;
  end if;
  v_problem := recipe.act_target_problem(old.state, new.state, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This accepted %s row cannot be recorded: %s. An accepted command names the exception or hold of the state it acts on and makes the change it records, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       coalesce(r.command_type, r.kind), v_problem);
  end if;
  return null;
end
$$;

create trigger zzk_execution_act_target after insert or update on recipe.execution_state
  for each row execute function recipe.execution_act_target_check();

revoke all on function recipe.act_target_problem(jsonb, jsonb, jsonb), recipe.execution_act_target_check() from public;

reset role;
