-- ST-33 (lead-approved behaviour, 13 November 2026; owner decision 0001 #2): a failed aseptic process simulation on a
-- master for the EU market takes the filling line out of use until QA requalifies it. EU GMP Annex 1 9.46 treats a
-- failed APS as an out-of-control process and, after the investigation, asks for repeat simulations (normally at least
-- three in a row) before the line is back in routine use. Revised Schedule M Part II 5.6(i) asks for an investigation
-- and the consideration of a repeat only, and 21 CFR 211 says nothing more specific, so a master without EU keeps the
-- exception and the deviation the reading already raises (critical limit breach of INJ-APS-READ), with no withdrawal.
-- Under owner decision 0001 #2 any contaminated unit fails the APS, on every line: the trigger reads the number of
-- contaminated units itself, not the formulation's limit.
--
-- Handbook: modules/tablets-server.md
--
--   plant.aps_failure_lines(batch, content, old state, new state)
--                             the PROCESS units to withdraw for a row of a batch's execution state: empty unless the
--                             pinned master's header.marketSet holds EU and the row adds (or changes) a 'reading' entry of
--                             a step of the catalogue's media-fill block INJ-APS-READ whose 'contaminated' count is above
--                             zero (and was not already above zero). The units are those named, in any library step of
--                             the batch, by an EQUIPMENT field of kind LINE (INJ-FILL's 'line'; the FFS and BFS machines),
--                             read from the entries' codes in the plant register; retired units are left alone.
--   plant.withdraw_lines_on_aps_failure()
--                             AFTER UPDATE on recipe.execution_state (every writer of the state): each unit gets
--                             QUALIFICATION_WITHDRAWN, reference and batch_ref = the media-fill batch number, detail
--                             "APS failed: repeat APS required (A1 9.46)", recorded as the person of the command row that
--                             recorded the reading. plant.equipment_fitness then answers NOT_QUALIFIED, so the fitness
--                             guard (tablets 1803 and the plant use checks) refuses the line in a step of any product until
--                             QA records it QUALIFIED again through plant.record_equipment_event, after the repeat APS.
--                             A unit whose latest qualification event is already this batch's withdrawal is not
--                             withdrawn twice.
--
-- Not built here (ST-33's other consequences): the quarantine of product made after the failure, the list of batches since
-- the last passing APS, the investigation record and the count of three repeat runs; QA's requalification stands for them.
-- Later (lead rulings, 13 November 2026): tablets 1912 finds the reading by its block's role APS_READING and marked count
-- instead of the code INJ-APS-READ, records the impact list at the withdrawal and requires QA's review (risk assessment,
-- repeat APS runs) before the line is QUALIFIED again; tablets 1913 lets the repeat media fills run on the withdrawn line.

set local role ebmr_owner;

create function plant.aps_failure_lines(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns uuid[]
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1       jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  v_node   jsonb;
  v_failed boolean := false;
  d        jsonb;
  f        jsonb;
  v_code   text;
  v_units  uuid[] := '{}';
  v_id     uuid;
  v_count  text;
  v_before text;
begin
  if jsonb_typeof(p_content -> 'header' -> 'marketSet') is distinct from 'array' or not (p_content -> 'header' -> 'marketSet') ? 'EU' then
    return v_units;
  end if;
  -- A reading of the media fill with a contaminated unit, added by this row (or changed to one by it).
  for k, e in select x.key, x.value from jsonb_each(e1) x where x.value ->> 'kind' = 'reading' loop
    v_count := e -> 'data' ->> 'contaminated';
    v_before := e0 -> k -> 'data' ->> 'contaminated';
    if v_count is null or v_count !~ '^[0-9]+(\.[0-9]+)?$' or v_count::numeric <= 0 then
      continue;
    end if;
    if v_before is not null and v_before ~ '^[0-9]+(\.[0-9]+)?$' and v_before::numeric > 0 then
      continue;
    end if;
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    if v_node -> 'block' ->> 'type' = 'LIB-INJ-APS-READ' then
      v_failed := true;
      exit;
    end if;
  end loop;
  if not v_failed then
    return v_units;
  end if;
  -- The lines the batch filled on: every EQUIPMENT field of kind LINE its library steps recorded.
  for k, e in select x.key, x.value from jsonb_each(e1) x order by x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    if coalesce(v_node -> 'block' ->> 'type', '') not like 'LIB-%' then
      continue;
    end if;
    d := recipe.library_definition(p_content, v_node -> 'block');
    for f in select x from jsonb_array_elements(coalesce(d -> 'sections', '[]'::jsonb)) sec, jsonb_array_elements(coalesce(sec -> 'fields', '[]'::jsonb)) x
              where sec ->> 'id' = e ->> 'kind' and x ->> 'type' = 'EQUIPMENT' and x ->> 'kind' = 'LINE' loop
      v_code := e -> 'data' ->> (f ->> 'id');
      if v_code is null then
        continue;
      end if;
      select q.id into v_id from plant.equipment q where q.code = v_code;
      if v_id is not null and not v_id = any (v_units) and plant.latest_event_of(v_id, array['RETIRED']) is null then
        v_units := v_units || v_id;
      end if;
    end loop;
  end loop;
  return v_units;
end
$$;

create function plant.withdraw_lines_on_aps_failure() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_units  uuid[];
  v_number text;
  c        recipe.execution_command;
  v_unit   uuid;
  v_last   plant.equipment_event;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where x.value ->> 'kind' = 'reading'
                    and (old.state -> 'entries' -> x.key) is distinct from x.value) then
    return null;
  end if;
  v_units := plant.aps_failure_lines(new.batch_id, recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if cardinality(v_units) = 0 then
    return null;
  end if;
  select b.batch_number into v_number from recipe.batch_execution b where b.id = new.batch_id;
  select * into c from recipe.execution_command x where x.batch_id = new.batch_id and x.seq = new.last_seq;
  if c.batch_id is null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-TAB-490 the media fill %s failed, but the row that recorded the reading is not found, so its lines cannot be withdrawn (ST-33)', v_number);
  end if;
  foreach v_unit in array v_units loop
    select * into v_last from plant.equipment_event q
     where q.equipment_id = v_unit and q.kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN')
     order by q.recorded_at desc, q.id desc limit 1;
    if v_last.kind = 'QUALIFICATION_WITHDRAWN' and v_last.reference is not distinct from v_number then
      continue;
    end if;
    insert into plant.equipment_event (equipment_id, kind, reference, batch_ref, detail, person_id, account_id)
    values (v_unit, 'QUALIFICATION_WITHDRAWN', v_number, v_number, 'APS failed: repeat APS required (A1 9.46)', c.actor_person, c.actor_account);
  end loop;
  return null;
end
$$;

create trigger zzi_aps_failure_withdraws_line after update on recipe.execution_state
  for each row execute function plant.withdraw_lines_on_aps_failure();

revoke all on function plant.aps_failure_lines(uuid, jsonb, jsonb, jsonb), plant.withdraw_lines_on_aps_failure() from public;

reset role;
