-- Tablets edition, module C3: what a test run's record holds, not only what its command sent, names only test
-- identifiers and registered test lots (Phase 2 exit review F12, round-2 verification; DI-05, INV-18, PR-18; ADR 0012:
-- the rules hold when the application's own database credentials are used directly).
--
-- 0370 applies tab.entry_identifier_problem to the entry of a RECORD_ENTRY command row. The record itself is the
-- engine state the row stores beside it (and the step content signed from it), and 0300 bound only the weighing facts
-- of a new state entry to its command. The round-2 verification stored, through the application role, a RECORD_ENTRY
-- whose command named the test batch TEST-B26-0007 while the new state entry held the real batch B24-0001: accepted,
-- and recipe.execution_state held the real identifier. (Recipe-core 0313 now binds every member a block takes over from
-- the command; this check is the edition's own rule on what the record holds, whatever the command.)
--
-- A row trigger on recipe.execution_state (zi_tab_state_entry_identifiers, after update; every row) refuses a row whose
-- state adds an entry (EBMR-EXE-078) whose data, read as an entry of its kind (tab.entry_identifier_problem: the batch
-- numbers, containers and lots of 0370, with the lot register comparison in a SANDBOX installation), names an
-- identifier this installation never records in an entry. One identifier is the system's own, not a person's: the id
-- the output weighing block generates for a container when the command names none (engine block G-22:
-- "<batch number>/<intermediate>/<sub-lot>/<n>"), which is built from the test batch's own number; it is accepted only
-- when the command names no container and the id begins with the batch's own number and a slash.
--
-- The trigger function is SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pins its search_path with
-- pg_temp last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, PR-18 (F12, round 2): why entry p_entry of a test run's state (id, kind, data), stored by a row whose command is
-- p_command, of batch number p_batch_number, names an identifier this installation never records in an entry; NULL when
-- it does not.
create function tab.state_entry_identifier_problem(p_entry jsonb, p_command jsonb, p_batch_number text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_data jsonb := case when jsonb_typeof(p_entry -> 'data') = 'object' then p_entry -> 'data' else '{}'::jsonb end;
begin
  -- The container id the output weighing generates from the batch's own number when the command names none.
  if p_entry ->> 'kind' = 'OUTPUT_CONTAINER' and not coalesce((p_command -> 'entry') ? 'container', false) and v_data ? 'container' then
    if jsonb_typeof(v_data -> 'container') is distinct from 'string' or p_batch_number is null
       or not starts_with(v_data ->> 'container', p_batch_number || '/') then
      return format('container %s is neither one the command named nor the id the system builds from the batch number %s',
                    left(coalesce(v_data ->> 'container', 'null'), 64), coalesce(p_batch_number, '(none)'));
    end if;
    v_data := v_data - 'container';
  end if;
  return tab.entry_identifier_problem(v_data || jsonb_build_object('kind', p_entry ->> 'kind'));
end
$$;

create function tab.state_entry_identifiers_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  r         recipe.execution_command;
  v_number  text;
  v_problem text;
  k         text;
  x         jsonb;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
               where not coalesce((old.state -> 'entries') ? e.key, false)
               order by e.key
  loop
    if v_number is null then
      select b.batch_number into v_number from recipe.batch_execution b where b.id = new.batch_id;
    end if;
    v_problem := tab.state_entry_identifier_problem(x, case when r.kind = 'PREPARE' then r.command -> 'target' else r.command end, v_number);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Entry %s (%s) that this %s row stores is refused: %s; the record of a test run holds only test identifiers and registered test lots (DI-05, PR-18). [EBMR-EXE-078]',
                         k, coalesce(x ->> 'kind', 'unnamed'), coalesce(r.command_type, r.kind, 'unknown'), v_problem);
    end if;
  end loop;
  return null;
end
$$;

create trigger zi_tab_state_entry_identifiers after update on recipe.execution_state
  for each row execute function tab.state_entry_identifiers_check();

revoke all on function tab.state_entry_identifier_problem(jsonb, jsonb, text), tab.state_entry_identifiers_check() from public;

reset role;
