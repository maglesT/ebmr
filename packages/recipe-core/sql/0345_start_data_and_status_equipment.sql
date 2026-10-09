-- Recipe core, execution store (module C3): a test run records no start data it cannot bind, a start-data authoriser is
-- a person of this installation, and an equipment status names equipment the MBR binds where its step runs (Phase 2 exit
-- review F12, the lane's round-3 verification, needs A and B; DI-05, DI-30, PR-23, PR-47; ADR 0012: the rules hold when
-- the application's own database credentials are used directly).
--
-- What was wrong.
--   (A) G-24's start data names its authoriser (authorisedBy, "the person id of the QCU approver" in the block's schema).
--       Nothing bound it except 0330's check that it is not the person who starts the step; 0332 types it as a text.
--       Through the application role, on the honest store and engine path, operator1 started a reprocessing step of an
--       MBR with a RECOVERY phase with start data {investigationRef, riskEvaluationRef, authorisationRef, authorisedBy:
--       'L2409-0017'}: accepted, with an identical replay. The server never sends start data (its START_STEP of such a
--       step answers G24-NOT-AUTHORISED), so such a row is never the server's.
--   (B) 0328 binds an equipment status's equipmentRef to the equipment its step lists for a status check, when it lists
--       any; the block reads an empty list as "any equipment the person names". Over HTTP, through the honest server,
--       an equipment status naming L2409-0017 at a G-09 step that lists no equipment was accepted.
--
-- What changed.
--   (A) recipe.start_data_problem, run by the constraint trigger zz_execution_row_start_data on recipe.execution_command
--       (after insert, not deferred; EBMR-EXE-126):
--       * an accepted START_STEP carries no start data (command.blockData), as an exception raised at no step carries no
--         context (0338): the server never sends it, and the quality unit's authorisation of a reprocessing is not given
--         through a test run in this release (the step stays refused G24-NOT-AUTHORISED, as the server answers today);
--       * on every row, accepted or refused, start data that names an authoriser names the id of a person of this
--         installation (iam.person), as an approval does (0342).
--   (B) recipe.status_equipment_problem, run by the row trigger zzl_execution_status_equipment on recipe.execution_state
--       (after update, every row that adds an entry; EBMR-EXE-126): an equipment status an accepted row adds at a step
--       that lists no equipment for a status check names equipment the batch's MBR binds where the step runs: equipment
--       its own node lists, or equipment the binding of a node enclosing it names (a stage's binding; for a step of a
--       library element, the nodes enclosing its library call). A step where the MBR binds no equipment records no
--       equipment status. Where the step lists equipment for a status check, 0328's rule stands.
-- Neither refusal repeats the value it refuses (as 0344's, so no log or stored answer copies it). Both bind meaning;
-- recipe-core 0344 reads the form of every text of the record besides. Stricter than the engine (it
-- accepts any authoriser and, at a step listing nothing, any equipment) and never weaker: a row the server writes passes.
--
-- Correction of an earlier claim (applied migrations are never edited): 0342 says the approver's id was "the one person
-- reference of a command bound to nothing"; G-24 start data's authorisedBy was another, bound by (A).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05, DI-30, PR-47 (A): why a row of kind p_kind, accepted p_accepted, with command p_command records start data it
-- may not, or names an authoriser that is not a person of this installation (header); NULL when it does neither.
create function recipe.start_data_problem(p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_by jsonb;
begin
  if p_kind is distinct from 'COMMAND' or jsonb_typeof(p_command) is distinct from 'object' or not (p_command ? 'blockData') then
    return null;
  end if;
  if p_accepted is true and p_command ->> 'type' = 'START_STEP' then
    return 'command.blockData is start data, which an accepted START_STEP never records: the server sends none, and a reprocessing''s authorisation by the quality unit is not given through a test run in this release';
  end if;
  if jsonb_typeof(p_command -> 'blockData') = 'object' and (p_command -> 'blockData') ? 'authorisedBy' then
    v_by := p_command -> 'blockData' -> 'authorisedBy';
    if jsonb_typeof(v_by) is distinct from 'string'
       or (v_by #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from iam.person p where p.id = (v_by #>> '{}')::uuid) then
      return 'command.blockData.authorisedBy is not the id of a person of this installation';
    end if;
  end if;
  return null;
end
$$;

-- DI-05, DI-30, PR-47 (A): start data is recorded only as the header says. EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_start_data_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text := recipe.start_data_problem(new.kind, new.accepted, new.command);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: %s. A test run records only start data it can bind, so nothing sits in the record unread (DI-05, DI-30, PR-47). [EBMR-EXE-126]',
                       case when new.accepted then 'accepted' else 'refused' end, coalesce(new.command_type, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create constraint trigger zz_execution_row_start_data after insert on recipe.execution_command
  for each row execute function recipe.execution_start_data_check();

-- PR-23, DI-05, DI-30 (B): the equipment refs MBR content p_content binds where step p_step (an expanded id) runs:
-- those its node lists, and those the binding of every node of the procedure enclosing it (or its first library call)
-- names. Sorted, distinct.
create function recipe.step_bound_equipment(p_content jsonb, p_step text) returns text[]
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct x.r order by x.r), '{}')
    from (select q.v ->> 'ref' as r
            from jsonb_array_elements(coalesce(case when jsonb_typeof(recipe.step_node(p_content, p_step) -> 'equipment') = 'array'
                                                    then recipe.step_node(p_content, p_step) -> 'equipment' end, '[]'::jsonb)) q (v)
          union all
          select q.v ->> 'ref'
            from jsonb_path_query(case when jsonb_typeof(p_content -> 'procedure') = 'object' then p_content -> 'procedure' else '{}'::jsonb end,
                                  'strict $.** ? (@.binding.equipment.type() == "array")') n
           cross join lateral jsonb_array_elements(n -> 'binding' -> 'equipment') q (v)
           where jsonb_path_exists(n -> 'body', 'strict $.** ? (@.id == $id)', jsonb_build_object('id', split_part(p_step, '/', 1)))) x
   where jsonb_typeof(to_jsonb(x.r)) = 'string'
$$;

-- PR-23, DI-05, DI-30 (B): why an equipment status that state p_new adds (not in p_old), at a step whose node in MBR
-- content p_content lists no equipment for a status check, names equipment the MBR does not bind where the step runs
-- (header); NULL when every one names such equipment, or its step lists equipment for a status check (0328).
create function recipe.status_equipment_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_step text;
  v_node jsonb;
  v_ref  text;
  v_have text[];
begin
  for k, e in select x.key, x.value
                from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) and x.value ->> 'kind' = 'EQUIPMENT_STATUS'
               order by x.key loop
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    continue when exists (select 1
                            from jsonb_array_elements(case when jsonb_typeof(v_node -> 'equipment') = 'array' then v_node -> 'equipment' else '[]'::jsonb end) q (v)
                           where q.v ->> 'use' = 'STATUS_CHECK');
    v_ref := case when jsonb_typeof(e -> 'data' -> 'equipmentRef') = 'string' then e -> 'data' ->> 'equipmentRef' end;
    v_have := recipe.step_bound_equipment(p_content, v_step);
    if v_ref is null or not (v_ref = any(v_have)) then
      return format('stores entry %s (EQUIPMENT_STATUS) of step %s for equipment that the batch''s MBR does not bind where step %s runs (it binds %s there)',
                    k, coalesce(e ->> 'stepKey', '(none)'), coalesce(v_step, '(none)'),
                    coalesce(nullif(array_to_string(v_have, ', '), ''), 'no equipment'));
    end if;
  end loop;
  return null;
end
$$;

-- PR-23, DI-05, DI-30 (B): an equipment status names equipment its MBR binds where its step runs (header).
-- EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_status_equipment_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where not coalesce((old.state -> 'entries') ? x.key, false) and x.value ->> 'kind' = 'EQUIPMENT_STATUS') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.status_equipment_problem(v_content, old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an equipment status names equipment the MBR binds where its step runs, so the record never holds equipment the MBR does not give it (DI-05, DI-30, PR-23). [EBMR-EXE-126]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zzl_execution_status_equipment after update on recipe.execution_state
  for each row execute function recipe.execution_status_equipment_check();

revoke all on function recipe.start_data_problem(text, boolean, jsonb), recipe.execution_start_data_check(),
                       recipe.step_bound_equipment(jsonb, text), recipe.status_equipment_problem(jsonb, jsonb, jsonb),
                       recipe.execution_status_equipment_check() from public;

reset role;
