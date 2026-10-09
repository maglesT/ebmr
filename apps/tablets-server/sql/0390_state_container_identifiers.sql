-- Tablets edition, module C3: a container a test run's record registers is named by a test identifier (Phase 2 exit
-- review F12, round-3 verification; DI-05, INV-18, PR-18; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- 0370 reads the identifiers of a RECORD_ENTRY command's entry and 0380 those of every entry a row's state adds. A
-- container the state registers (state.containers) was read by neither: the round-3 verification stored, through the
-- application role, operator1's PREVIOUS_BATCH entry (a test batch number) on the line clearance with a container
-- L2409-0017 registered beside it (sandbox.identifier_problem('LOT_NUMBER', 'L2409-0017') gives EBMR-SBX-022):
-- accepted, and the record held the real identifier. (Recipe-core 0317 now binds every new container to the entry that
-- registers it; this check is the edition's own rule on what the record holds, whatever the entry.)
--
-- tab.state_entry_identifiers_check, the function of the trigger zi_tab_state_entry_identifiers of 0380 (CREATE OR
-- REPLACE; its body carried), also refuses a row whose state adds a container (EBMR-EXE-078) whose key or id is not a
-- test lot number of this installation (tab.state_container_identifier_problem: sandbox.identifier_problem LOT_NUMBER,
-- the rule 0370 applies to the container an entry names). As in 0380, one id is the system's own: the one the output
-- weighing block builds from the test batch's own number when its command names no container (engine block G-22:
-- "<batch number>/<intermediate>/<sub-lot>/<n>"); it is accepted only for an OUTPUT_CONTAINER command that names no
-- container, when the id begins with the batch's own number and a slash.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pin their search_path with pg_temp
-- last. CREATE OR REPLACE keeps the owner, the privileges and the search_path of the trigger function of 0380. Applied
-- as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, PR-18 (F12, round 3): why container p_container, registered under key p_key in a test run's state by a row
-- whose command is p_command, of batch number p_batch_number, is named by an identifier this installation never
-- records; NULL when it is not.
create function tab.state_container_identifier_problem(p_key text, p_container jsonb, p_command jsonb, p_batch_number text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, sandbox, pg_temp as $$
declare
  v_id text;
  v_p  text;
begin
  foreach v_id in array array_remove(array[p_key, case when jsonb_typeof(p_container -> 'id') = 'string' and p_container ->> 'id' <> p_key then p_container ->> 'id' end], null) loop
    -- The id the output weighing builds from the batch's own number, for a command that names no container.
    continue when p_command -> 'entry' ->> 'kind' = 'OUTPUT_CONTAINER' and not coalesce((p_command -> 'entry') ? 'container', false)
                  and p_batch_number is not null and starts_with(v_id, p_batch_number || '/');
    v_p := sandbox.identifier_problem('LOT_NUMBER', v_id);
    if v_p is not null then
      return format('container %s', regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
  end loop;
  return null;
end
$$;

-- As 0380, and (F12, round 3) every container the row's state adds (header).
create or replace function tab.state_entry_identifiers_check() returns trigger
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
  for k, x in select c.key, c.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'containers') = 'object' then new.state -> 'containers' else '{}'::jsonb end) c
               where not coalesce((old.state -> 'containers') ? c.key, false)
               order by c.key
  loop
    if v_number is null then
      select b.batch_number into v_number from recipe.batch_execution b where b.id = new.batch_id;
    end if;
    v_problem := tab.state_container_identifier_problem(k, x, case when r.kind = 'PREPARE' then r.command -> 'target' else r.command end, v_number);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Container %s that this %s row registers is refused: %s; the record of a test run holds only test identifiers and registered test lots (DI-05, PR-18). [EBMR-EXE-078]',
                         left(k, 64), coalesce(r.command_type, r.kind, 'unknown'), v_problem);
    end if;
  end loop;
  return null;
end
$$;

revoke all on function tab.state_container_identifier_problem(text, jsonb, jsonb, text) from public;

reset role;
