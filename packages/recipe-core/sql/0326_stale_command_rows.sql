-- Recipe core, execution store (module C3): a command sent from a screen that showed another version of the run is
-- recorded as the engine's refusal ENG-STALE, and only such a command is; that refusal changes nothing (Phase 2 exit
-- review F58 and its follow-up F58.1; DI-34; ADR 0012: the rules hold when the application's own database credentials
-- are used directly).
--
-- The engine's first check of a command (engine.ts step, after the repeated-command check) is its optimistic lock: a
-- command that names the version of the run its screen showed (expectedVersion) is refused ENG-STALE when the run is
-- at another version, before anything else is looked at; the refusal keeps the state, apart from what the time sweep
-- finds at that moment. Until now this rule lived only in TypeScript. The database recorded whatever verdict the writer
-- stored: an accepted command from an older screen, an ENG-STALE refusal of a command whose screen showed the run's own
-- version (a false reason in the record), or a stale refusal whose state moved the version on or started a step. Only
-- the replay (ADR 0010) disagreed.
--
-- F58 first answered a stale run command before anything was written, so its readings were not spent; the attempt then
-- left no row, against DI-34's rule that a refused engine call is a row with its refusal. The server records it again
-- (apps/tablets-server features/execution: the readings of a stale weighing are named, not used; tablets 0500), and this
-- migration makes the database hold every such row to the engine's rule:
--
--   1. recipe.stale_command_problem(p_command, p_accepted, p_refusal, p_version), pure: why a row whose command is
--      p_command, recorded accepted p_accepted with refusal p_refusal while the run is at version p_version, disagrees
--      with the engine's check; NULL when it agrees:
--        * an expectedVersion the command names is a whole number of the range of a run's version (the screen's
--          version as the engine compares it: JSON 7 and 7.0 are the same number, "7" is not a number);
--        * a command whose expectedVersion is not the run's version is recorded only as refused with ENG-STALE;
--        * a refusal ENG-STALE is recorded only for a command that names an expectedVersion other than the run's.
--   2. a row trigger on recipe.execution_command (ab_execution_stale_command, before insert; every row but the ISSUE,
--      which has no version before it): the run's version is the projection's (recipe.execution_state, locked by
--      recipe.append_execution and not yet moved by this row). EBMR-EXE-140.
--   3. a row trigger on recipe.execution_state (zn_execution_stale_refusal, after update): a row recorded as the refusal
--      ENG-STALE stores the state before it, changed only as the engine's time sweep changes it (recipe.sweep_state_problem
--      of 0303: the last time seen, the time instances, the exceptions the sweep raises and their counter, the event
--      counter moved on by exactly the row's events), never its version, a step, a value, an entry or anything else.
--      What the sweep may record is proved by 0299 for every row. EBMR-EXE-140.
-- A stale refusal keeps the command as the server resolved it (what was entered) and the version the screen showed
-- (command.expectedVersion), with the engine's refusal: recipe.append_execution already refuses a refused row without
-- its refusal (EBMR-EXE-030).
--
-- The signing ceremony's own check at the challenge (apps/tablets-server features/execution signable.ts
-- prepareForChallenge) answers a stale screen before the PIN is asked for and writes nothing: no engine call is made
-- there. A signature whose run moved on after its challenge is refused by the engine in the dry run and recorded as
-- before (a refused COMMAND row with the placeholder signature), and these rules hold for it too.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- DI-34 (F58.1): why a row's verdict disagrees with the engine's version check (header, item 1); NULL when it agrees.
-- The text completes "This <accepted|refused> <type> row ...".
create function recipe.stale_command_problem(p_command jsonb, p_accepted boolean, p_refusal jsonb, p_version integer) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_seen  jsonb := case when jsonb_typeof(p_command) = 'object' then p_command -> 'expectedVersion' end;
  v_code  text := case when p_accepted is false and jsonb_typeof(p_refusal) = 'object' then p_refusal ->> 'code' end;
  v_stale boolean;
begin
  if v_seen is not null
     and (jsonb_typeof(v_seen) is distinct from 'number' or (v_seen::text)::numeric <> trunc((v_seen::text)::numeric)
          or (v_seen::text)::numeric < 0 or (v_seen::text)::numeric > 2147483647) then
    return format('names %s as the version its screen showed, which is not a version of a run', v_seen::text);
  end if;
  v_stale := v_seen is not null and (v_seen::text)::numeric is distinct from p_version;
  if v_stale and v_code is distinct from 'ENG-STALE' then
    return format('was sent from a screen that showed version %s while the run is at version %s, and is recorded %s; a command from a screen that shows another version is recorded only as the engine''s refusal ENG-STALE',
                  v_seen::text, coalesce(p_version::text, '(none)'),
                  case when p_accepted is true then 'as accepted' else format('with the refusal %s', coalesce(v_code, '(none)')) end);
  end if;
  if not v_stale and v_code = 'ENG-STALE' then
    return format('is recorded as the refusal ENG-STALE, but %s; that refusal is the engine''s answer to a command from a screen that showed another version of the run',
                  case when v_seen is null then 'its command names no version its screen showed'
                       else format('the version its screen showed, %s, is the run''s own', v_seen::text) end);
  end if;
  return null;
end
$$;

-- DI-34 (F58.1): a row's verdict agrees with the engine's version check (header, item 2). EBMR-EXE-140. Raises;
-- returns the row.
create function recipe.execution_stale_command_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_version integer;
  v_problem text;
begin
  if new.kind = 'ISSUE' then
    return new;
  end if;
  select s.state_version into v_version from recipe.execution_state s where s.batch_id = new.batch_id;
  v_problem := recipe.stale_command_problem(new.command, new.accepted, new.refusal, v_version);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s (DI-34). [EBMR-EXE-140]',
                       case when new.accepted then 'accepted' else 'refused' end, coalesce(new.command_type, new.kind), v_problem);
  end if;
  return new;
end
$$;

create trigger ab_execution_stale_command before insert on recipe.execution_command
  for each row execute function recipe.execution_stale_command_check();

-- DI-34 (F58.1): a stale refusal changes nothing but the time sweep's findings (header, item 3). EBMR-EXE-140. Runs
-- after the projection is written; the row that produced the state is the one it names (last_seq). Raises; returns
-- nothing.
create function recipe.execution_stale_refusal_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind is distinct from 'COMMAND' or r.accepted is distinct from false or r.refusal ->> 'code' is distinct from 'ENG-STALE' then
    return null;
  end if;
  v_problem := recipe.sweep_state_problem(old.state, new.state, r.event_count);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('Row %s is the refusal ENG-STALE of a %s command from a screen that showed an older version of the run, and the state it stores %s: a stale command changes nothing; only what the time sweep finds at that moment is recorded with it (DI-34). [EBMR-EXE-140]',
                       r.seq, coalesce(r.command_type, r.kind), v_problem);
  end if;
  return null;
end
$$;

create trigger zn_execution_stale_refusal after update on recipe.execution_state
  for each row execute function recipe.execution_stale_refusal_check();

revoke all on function recipe.stale_command_problem(jsonb, boolean, jsonb, integer), recipe.execution_stale_command_check(),
                       recipe.execution_stale_refusal_check() from public;

reset role;
