-- Recipe core, execution store (module C3): a new entry holds what its command sent, member for member, for every kind
-- of entry (Phase 2 exit review F12, round-2 verification; DI-30, DI-05, DI-14; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- 0300 binds a new block entry to its row (the row's own accepted RECORD_ENTRY of its kind, or the start data of its
-- START_STEP, in its step and its person's name), but of its data only the weighing facts (source, balance, gross,
-- tare, unit). The round-2 verification stored, through the application role, operator1's RECORD_ENTRY whose command
-- named the test batch TEST-B26-0007 as the previous batch of the line clearance while the new entry in the state held
-- the real batch B24-0001 and the real product name. Tablets 0370 checks the command's entry only; the database
-- answered 'ok', and the record (the state, and the step content signed from it) held the real identifier.
--
-- The blocks build an entry's data from the command's entry (engine steps.ts recordEntry: the block handler's
-- acceptEntry; startStep: the start data as sent). Each member they take over keeps its name and value (a block's
-- entry schema refuses unknown members, so a checklist's answers are taken over as sent, and an acknowledgement's SOP
-- version is accepted only when it is the MBR's own); the members they add (the person, a label, a computed net, a
-- generated id) have names the command does not use. This migration adds a row trigger on recipe.execution_state
-- (zh_execution_entry_data, after update; every row): every member of the command's entry (of a RECORD_ENTRY; of the
-- start data of a START_STEP for a START_DATA entry), other than its kind, that the new entry's data also holds, holds
-- the same value (recipe.entry_data_problem, EBMR-EXE-126, the code of 0300's binding of new values). A member the
-- block does not take over is not required (a block may drop it, as the charge of a container drops the batch read
-- from its label); a member the state adds under another name is the block's, and the tablets edition reads what it
-- names as identifiers (tablets 0380).
--
-- The check is a pure function compared with the engine's own runs (packages/recipe-core/test/execution
-- entry-data-sql.test.ts). New functions are owned by ebmr_owner and private to the owner; the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-30 (F12, round 2): why a new entry of state p_new (not in p_old), stored by a row (kind p_kind, accepted p_accepted,
-- command p_command as recorded), holds another value under a member of the command's entry than the command sent
-- (header); NULL when none does. The text completes "This <row> ...".
create function recipe.entry_data_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type text := case when p_kind = 'COMMAND' and p_accepted is true then p_command ->> 'type' end;
  v_sent jsonb;
  k      text;
  x      jsonb;
  m      text;
begin
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) e
               where not coalesce((p_old -> 'entries') ? e.key, false)
               order by e.key
  loop
    v_sent := case when x ->> 'kind' = 'START_DATA' and v_type = 'START_STEP' then p_command -> 'blockData'
                   when v_type = 'RECORD_ENTRY' then p_command -> 'entry' end;
    if jsonb_typeof(v_sent) is distinct from 'object' or jsonb_typeof(x -> 'data') is distinct from 'object' then
      return format('stores entry %s (%s), and no data its command sent stands behind it', k, coalesce(x ->> 'kind', '?'));
    end if;
    for m in select s.key
               from jsonb_each(v_sent) s
              where s.key <> 'kind' and (x -> 'data') ? s.key and (x -> 'data' -> s.key) is distinct from s.value
              order by s.key
    loop
      return format('stores another %s in entry %s (%s) than its command sent', m, k, coalesce(x ->> 'kind', '?'));
    end loop;
  end loop;
  return null;
end
$$;

-- DI-30, DI-05 (F12, round 2): a new entry holds what its command sent (header). EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_entry_data_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := recipe.entry_data_problem(old.state, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry records what was entered (DI-30, DI-05). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zh_execution_entry_data after update on recipe.execution_state
  for each row execute function recipe.execution_entry_data_check();

revoke all on function recipe.entry_data_problem(jsonb, jsonb, text, boolean, jsonb), recipe.execution_entry_data_check() from public;

reset role;
