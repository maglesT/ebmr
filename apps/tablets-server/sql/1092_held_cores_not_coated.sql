-- Tablets server, Phase 3 slice 6d (GB-T-01 residual, coordinator): material on hold is never used. A failing or missed
-- compression check holds the output containers made since the last passing check (TB-11, recipe-core 0422 and 0540),
-- and plant.charge_container already refuses a held container; but TB-18 loads the coating pan with a quantity of cores
-- (PAN_LOAD) and names no container, so cores under hold could be coated. The database now refuses that row
-- (controls PR-29, IN-35, IN-37; ADR 0012: the rule holds when the application's own credentials are used directly).
--
--   * tab.held_compression_containers(batch): the labels of the batch's compression output containers under an open
--     hold: HELD or SORTED, or still open with a hold recorded against it (it is held when it closes). A compression output
--     container is one of stage COMPRESSION, or one filled on a press the batch's TB-11 compression run started on
--     (RUN_START of a TB-11 step whose process is COMPRESSION). A container QA released (RELEASED_BY_QA) or rejected
--     (REJECTED) is no longer under hold.
--   * A row trigger on recipe.execution_state (zzi_tab_held_cores, after update) refuses a row that records a new
--     PAN_LOAD entry at a TB-18 step while that list is not empty (EBMR-TAB-390, rule TB18-HELD-CORES). QA decides on
--     the held containers first (release with OUTPUT_CONTAINER_RELEASED, or reject).
--
-- New functions are owned by ebmr_owner; the trigger function is SECURITY DEFINER; every function pins its search_path
-- with pg_temp last (ADR 0016).

set local role ebmr_owner;

create function tab.held_compression_containers(p_batch uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
  with presses as (
    select distinct e.value -> 'data' ->> 'press' as press
      from recipe.execution_state s
      cross join lateral jsonb_each(case when jsonb_typeof(s.state -> 'entries') = 'object' then s.state -> 'entries' else '{}'::jsonb end) e
     where s.batch_id = p_batch
       and e.value ->> 'kind' = 'RUN_START'
       and recipe.step_node(recipe.batch_mbr_content(p_batch), s.state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') -> 'block' ->> 'type' = 'TB-11'
       and coalesce(recipe.step_node(recipe.batch_mbr_content(p_batch), s.state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') -> 'config' ->> 'process', 'COMPRESSION') = 'COMPRESSION'
  )
  select coalesce(array_agg(c.label_code order by c.label_code), '{}')
    from plant.output_container c
   where c.batch_id = p_batch
     and (c.stage = 'COMPRESSION' or c.press_code in (select press from presses))
     and (plant.container_state(c.id) in ('HELD', 'SORTED')
          or (plant.container_state(c.id) in ('OPEN', 'CLOSED') and exists (select 1 from plant.container_hold h where h.container_id = c.id)))
$$;

create function tab.held_cores_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_held    text[];
  k         text;
  e         jsonb;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
               where x.value ->> 'kind' = 'PAN_LOAD'
                 and not coalesce((old.state -> 'entries') ? x.key, false) loop
    v_content := coalesce(v_content, recipe.batch_mbr_content(new.batch_id));
    if recipe.step_node(v_content, new.state -> 'steps' -> (e ->> 'stepKey') ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-18' then
      continue;
    end if;
    v_held := tab.held_compression_containers(new.batch_id);
    if cardinality(v_held) > 0 then
      raise exception using errcode = 'P0001',
        message = format('The pan load at %s is refused: the compression output container(s) %s are on hold, and material on hold is never used until QA releases or rejects it (TB18-HELD-CORES; PR-29, IN-35, IN-37). [EBMR-TAB-390]',
                         e ->> 'stepKey', array_to_string(v_held, ', '));
    end if;
  end loop;
  return null;
end
$$;

create trigger zzi_tab_held_cores after update on recipe.execution_state
  for each row execute function tab.held_cores_check();

revoke all on function tab.held_compression_containers(uuid), tab.held_cores_check() from public;

reset role;
