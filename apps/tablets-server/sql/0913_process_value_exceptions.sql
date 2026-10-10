-- Tablets server, Phase 3 slice 3d quick review finding 1: the exceptions G-06's values raise are required by the database
-- at every step that carries G-06's entries (controls PR-08, PR-14, DI-31, DI-32, DI-49; ADR 0012: the rules hold when
-- the application's own database credentials are used directly).
--
-- recipe-core 0520 holds what a G-06 entry's data say (a value inside or outside its acceptance limits, a read-back or
-- recipe that matches or not, usable or not, keyed by hand under the fallback path, a GMP-critical alarm), but the
-- exception the block raises with it was required only at TB-06 and TB-16 steps (tablets 0932). A tampered handler
-- could store a coater value outside its limits at a TB-18 step, or at G-06, TB-04, TB-05, TB-07, TB-10 and TB-17 steps,
-- without PROCESS_VALUE_OUT_OF_LIMITS. One shared check now covers every step whose block runs on a process device
-- (tab.process_block_type: G-06 and the Tablets blocks that carry its configuration):
--
--   tab.g06_exception_problem   why a row's new G-06 entries are not each stored with the exception automated.ts raises
--                               with it, as the engine raises it, in the same row:
--                                 ACTUAL outside its limits      PROCESS_VALUE_OUT_OF_LIMITS (ACTION, a deviation, the
--                                                                steps after it held until one is linked)
--                                 read-back that does not match  SETPOINT_MISMATCH (ACTION, the step and the steps after
--                                                                it held until QA decides)
--                                 recipe check that does not     RECIPE_MISMATCH (as SETPOINT_MISMATCH)
--                                 match
--                                 value not usable               PROCESS_DATA_UNUSABLE (alert)
--                                 value keyed by hand            PROCESS_MANUAL_FALLBACK (alert)
--                                 GMP-critical alarm             GMP_CRITICAL_ALARM (alert, DI-49)
--                                 interface loss                 INTERFACE_LOSS (alert)
--                               counted per step and type, so two such entries of one row need two exceptions;
--   tab.g06_exception_check     the row trigger on recipe.execution_state (zt_tab_g06_exceptions, after update), EBMR-EXE-275.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- PR-08, PR-14, DI-31, DI-32, DI-49 (header): NULL when every new G-06 entry of row p_new (after p_old, MBR p_content)
-- is stored with the exceptions its block raises with it.
create function tab.g06_exception_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  x0     jsonb := case when jsonb_typeof(p_old -> 'exceptions') = 'object' then p_old -> 'exceptions' else '{}'::jsonb end;
  r      record;
  v_have bigint;
begin
  for r in
    with fresh as (
      select x.key as id, x.value as e, x.value ->> 'stepKey' as step_key, x.value ->> 'kind' as kind,
             case when jsonb_typeof(x.value -> 'data') = 'object' then x.value -> 'data' else '{}'::jsonb end as d
        from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
       where not (e0 ? x.key)
         and x.value ->> 'kind' in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'INTERFACE_LOSS', 'RECIPE_CHECK')
         and exists (select 1 from tab.process_block_type t
                      where t.block_type = recipe.step_node(p_content, p_new -> 'steps' -> (x.value ->> 'stepKey') ->> 'step') -> 'block' ->> 'type')),
    wanted as (
      select step_key, 'PROCESS_VALUE_OUT_OF_LIMITS' as type, min(id) as entry from fresh where kind = 'ACTUAL' and (d -> 'withinLimits') = 'false'::jsonb group by step_key, id
      union all
      select step_key, 'SETPOINT_MISMATCH', min(id) from fresh where kind = 'SETPOINT_READBACK' and (d -> 'matches') = 'false'::jsonb group by step_key, id
      union all
      select step_key, 'RECIPE_MISMATCH', min(id) from fresh where kind = 'RECIPE_CHECK' and (d -> 'matches') = 'false'::jsonb group by step_key, id
      union all
      select step_key, 'PROCESS_DATA_UNUSABLE', min(id) from fresh where kind in ('ACTUAL', 'SETPOINT_READBACK') and (d -> 'usable') = 'false'::jsonb group by step_key, id
      union all
      select step_key, 'PROCESS_MANUAL_FALLBACK', min(id) from fresh where (d -> 'manualFallback') = 'true'::jsonb group by step_key, id
      union all
      select step_key, 'GMP_CRITICAL_ALARM', min(id) from fresh where kind = 'ALARM' and (d -> 'critical') = 'true'::jsonb group by step_key, id
      union all
      select step_key, 'INTERFACE_LOSS', min(id) from fresh where kind = 'INTERFACE_LOSS' group by step_key, id)
    select w.step_key, w.type, count(*) as n, min(w.entry) as entry from wanted w group by w.step_key, w.type order by 1, 2
  loop
    select count(*) into v_have
      from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where not (x0 ? x.key) and x.value ->> 'type' = r.type and x.value -> 'source' ->> 'stepKey' = r.step_key
       and case r.type
             when 'PROCESS_VALUE_OUT_OF_LIMITS' then
               x.value ->> 'severity' = 'ACTION' and (x.value -> 'deviationRequired') = 'true'::jsonb
               and x.value -> 'block' ->> 'until' = 'DEVIATION' and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object'
             when 'SETPOINT_MISMATCH' then
               x.value ->> 'severity' = 'ACTION' and (x.value -> 'qaOnly') = 'true'::jsonb and x.value -> 'block' ->> 'until' = 'DISPOSITION'
               and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object' and (x.value -> 'block' -> 'steps') @> jsonb_build_array(r.step_key)
             when 'RECIPE_MISMATCH' then
               x.value ->> 'severity' = 'ACTION' and (x.value -> 'qaOnly') = 'true'::jsonb and x.value -> 'block' ->> 'until' = 'DISPOSITION'
               and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object' and (x.value -> 'block' -> 'steps') @> jsonb_build_array(r.step_key)
             else x.value ->> 'severity' = 'ALERT'
           end;
    if v_have < r.n then
      return format('stores entry %s of step %s without the %s exception its block raises with it (G-06; %s)', r.entry, r.step_key, r.type,
                    case r.type when 'PROCESS_VALUE_OUT_OF_LIMITS' then 'PR-08' when 'GMP_CRITICAL_ALARM' then 'DI-49' else 'PR-14' end);
    end if;
  end loop;
  return null;
end
$$;

-- The row trigger (header).
create function tab.g06_exception_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  if new.state -> 'entries' is not distinct from old.state -> 'entries' then
    return null;
  end if;
  v_problem := tab.g06_exception_problem(recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a value of automated equipment is stored with the exception it raises (PR-08, PR-14, DI-31, DI-32, DI-49). [EBMR-EXE-275]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zt_tab_g06_exceptions after update on recipe.execution_state
  for each row execute function tab.g06_exception_check();

revoke all on function tab.g06_exception_problem(jsonb, jsonb, jsonb), tab.g06_exception_check() from public;

reset role;
