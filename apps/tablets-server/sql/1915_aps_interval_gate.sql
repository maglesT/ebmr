-- Injectables I-6, INV-23 (c) (lead rulings, 14 November 2026): a filling line fills an aseptic batch only while its
-- aseptic process simulation (APS, media fill) is valid. Binding clauses, paraphrased: revised Schedule M Part II 5.5
-- (the aseptic process is validated by process simulation, repeated at set intervals and after significant change) and
-- 21 CFR 211.113(b) (the procedures that prevent microbiological contamination of sterile products include the
-- validation of every aseptic process). The validity of a line is its last passing APS plus an interval the firm sets
-- for that line; there is no default.
--
-- Handbook: modules/injectables.md
--
-- (a) The interval (the pattern of recipe.bright_stock_max_hold, recipe-core 0871, with QA's approval as in 1210).
--
--   plant.aps_interval        insert-only (audited, aggregate plant_equipment): a version per line of the firm's interval
--                             in whole days (1 to 3650), with its reason and proposer. A proposal takes no effect alone.
--   plant.aps_interval_approval
--                             insert-only (audited): QA's approval of one version. Whoever writes it (trigger
--                             ab_aps_interval_approval): the version is the latest of its line, not yet approved, and the
--                             approver is not its proposer (EBMR-PLANT-091).
--   plant.propose_aps_interval(line code, days, reason)
--                             MASTERDATA.CHANGE, never an administrator: the next version of the line's interval; a
--                             missing or out-of-range number of days or a reason under ten characters is refused, nothing
--                             is defaulted (EBMR-PLANT-090).
--   plant.approve_aps_interval(interval id)
--                             PLANT_RULE.APPROVE (QA MBR approver, QA reviewer), never an administrator: as the trigger
--                             (EBMR-PLANT-091).
--   plant.aps_interval_days(unit)
--                             in force: the days of the line's latest approved version; NULL without one (a pending
--                             proposal changes nothing until QA approves it).
--   plant.aps_valid_until_us(line code, at)
--                             the line's last passing APS (the latest use of the line by a batch holding an APS_READING
--                             reading of zero, plant.line_batch_uses of 1912) up to `at`, plus its interval; NULL without
--                             an interval or without a passing APS.
--
-- (b) Where the check runs: ad_plant_aps_interval, before insert on recipe.execution_command, an accepted COMMAND row of
--     a GMP batch in scope (plant.aps_interval_scope): its master is of the injectables edition, its header's recordKind
--     is PROCESSING, no step's block definition has the role TERMINAL_STERILISATION (roles read as 3080 reads them), and
--     the batch is no process simulation (recipe.process_simulation_batch, recipe-core 1896). The command's time is the
--     row's now_us, the trusted transaction time the writer asserts (INV-16). A sandbox test run fills no product and is
--     not checked.
--
--   plant.aps_entry_lines(content, step, section, data)
--                             the line codes an entry sets: EQUIPMENT fields of kind LINE of the section in the step's
--                             library definition snapshot (as plant.line_uses of 1912 reads them), not of a block whose
--                             category is PACKAGING (the generic PACK-* blocks). No block code or role is read.
--   plant.aps_interval_problem(batch, content, command type, command, state, now_us)
--       RECORD_ENTRY      each line the entry sets: refused while no interval is in force for it (EBMR-PLANT-092), and
--                         while it has no passing APS or its last passing APS plus the interval is at or before the
--                         command's time (EBMR-PLANT-093).
--       SIGN_PERFORMED    a lapse during the fill: each line the step's entries set whose validity ended at or before
--                         the sign-off. Later entries are not refused; the sign-off is refused (EBMR-PLANT-094) until
--                         the step holds an exception raised at it after the validity ended, of severity ACTION or
--                         CRITICAL with a deviation required (an ACTION exception the person raises, RAISE_EXCEPTION,
--                         requires one and stops the steps after it, engine batch.ts), the deviation linked and the
--                         exception dispositioned DEVIATION_RAISED by QA (the register's rules, recipe-core 0440).
--
-- (c) The engine raises the lapse (lead ruling, 15 November 2026): at the filling step's sign-off the server reads
--     plant.aps_sign_off_facts and states the lines' validity in the command; the engine raises LIB_APS_LAPSED, an ACTION
--     exception requiring a deviation that holds the step and the steps after it until QA dispositions it under the
--     linked deviation. -094 stays as the backstop for a sign-off written past the engine.
--
-- Messages: EBMR-PLANT-090 to EBMR-PLANT-094. PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------------------------- (a)

create table plant.aps_interval (
  id                   uuid primary key default gen_random_uuid(),
  equipment_id         uuid not null references plant.equipment (id),
  version              integer not null check (version >= 1),
  interval_days        integer not null check (interval_days between 1 and 3650),
  reason               text not null check (reason = btrim(reason) and length(reason) between 10 and 2000),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  unique (equipment_id, version)
);
revoke all on plant.aps_interval from public;
grant select on plant.aps_interval to ebmr_app;
select platform.enforce_db_time('plant.aps_interval', array['recorded_at']);
select kernel.register_audited_table('plant.aps_interval', 'plant_equipment', 'equipment_id', true);

create table plant.aps_interval_approval (
  interval_id          uuid primary key references plant.aps_interval (id),
  equipment_id         uuid not null references plant.equipment (id),
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on plant.aps_interval_approval from public;
grant select on plant.aps_interval_approval to ebmr_app;
select platform.enforce_db_time('plant.aps_interval_approval', array['approved_at']);
select kernel.register_audited_table('plant.aps_interval_approval', 'plant_equipment', 'equipment_id', true);

-- Whoever writes an approval: the latest version of its line, once, never by its proposer.
create function plant.aps_interval_approval_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v plant.aps_interval;
begin
  select * into v from plant.aps_interval i where i.id = new.interval_id;
  if v.id is null or v.equipment_id is distinct from new.equipment_id then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-091 the approval names no proposed APS interval of its line (Schedule M Part II 5.5)';
  end if;
  if exists (select 1 from plant.aps_interval l where l.equipment_id = v.equipment_id and l.version > v.version) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLANT-091 version %s of the APS interval is superseded by a later proposal: QA approves the latest one (Schedule M Part II 5.5)', v.version);
  end if;
  if new.approved_by_person = v.proposed_by_person then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-091 the person who proposed the APS interval does not approve it: QA approves another person''s proposal (Schedule M Part II 5.5)';
  end if;
  return new;
end
$$;
create trigger ab_aps_interval_approval before insert on plant.aps_interval_approval for each row execute function plant.aps_interval_approval_guard();

create function plant.propose_aps_interval(p_line_code text, p_days integer, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  e       plant.equipment;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  e := plant.equipment_by_code(p_line_code, true);
  if p_days is null or p_days not between 1 and 3650 then
    perform plant.fail(format('EBMR-PLANT-090 the firm sets the APS interval of %s in whole days, 1 to 3650; there is no default (Schedule M Part II 5.5)', e.code));
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 10 then
    perform plant.fail(format('EBMR-PLANT-090 the APS interval of %s states its reason (at least ten characters)', e.code));
  end if;
  insert into plant.aps_interval (equipment_id, version, interval_days, reason, proposed_by_person, proposed_by_account)
  values (e.id, coalesce((select max(i.version) from plant.aps_interval i where i.equipment_id = e.id), 0) + 1, p_days, btrim(p_reason),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function plant.approve_aps_interval(p_interval uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  v       plant.aps_interval;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('PLANT_RULE.APPROVE', '{}'::jsonb);
  select * into v from plant.aps_interval i where i.id = p_interval for update;
  if v.id is null or exists (select 1 from plant.aps_interval_approval a where a.interval_id = v.id) then
    perform plant.fail(format('EBMR-PLANT-091 %s is no APS interval waiting for QA''s approval (Schedule M Part II 5.5)', coalesce(p_interval::text, 'NULL')));
  end if;
  insert into plant.aps_interval_approval (interval_id, equipment_id, approved_by_person, approved_by_account)
  values (v.id, v.equipment_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return v.id;
end
$$;

-- In force: the latest approved version of the line (NULL: none).
create function plant.aps_interval_days(p_equipment uuid) returns integer
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select i.interval_days from plant.aps_interval i join plant.aps_interval_approval a on a.interval_id = i.id
   where i.equipment_id = p_equipment order by i.version desc limit 1
$$;

-- The end of the line's APS validity at p_at_us (engine microseconds); NULL without an interval or a passing APS.
create function plant.aps_valid_until_us(p_code text, p_at_us bigint) returns bigint
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select (select max(u.used_us) from plant.line_batch_uses(p_code) u where u.good_aps and u.used_us <= p_at_us)
         + (select plant.aps_interval_days(q.id) from plant.equipment q where q.code = p_code)::bigint * 86400000000
$$;

-- ---------------------------------------------------------------------------------------------------------------- (b)

-- A GMP batch filling aseptically: injectables, PROCESSING, no terminal sterilisation step, no process simulation.
create function plant.aps_interval_scope(p_batch uuid, p_content jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_tree  jsonb;
  v_roles jsonb;
  id      text;
begin
  if p_content -> 'header' ->> 'edition' is distinct from 'injectables' or p_content -> 'header' ->> 'recordKind' is distinct from 'PROCESSING'
     or not exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH')
     or recipe.process_simulation_batch(p_batch) then
    return false;
  end if;
  v_tree := recipe.flow_tree(p_content);
  for id in select x.key from jsonb_each(case when jsonb_typeof(v_tree -> 'ids') = 'object' then v_tree -> 'ids' else '{}'::jsonb end) x
             where x.value ->> 'kind' = 'phase' loop
    v_roles := recipe.library_definition(p_content, recipe.step_node(p_content, id) -> 'block') -> 'roles';
    if jsonb_typeof(v_roles) = 'array' and v_roles ? 'TERMINAL_STERILISATION' then
      return false;
    end if;
  end loop;
  return true;
end
$$;

-- The line codes entry data p_data of section p_section at step p_step sets (not a PACKAGING block's).
create function plant.aps_entry_lines(p_content jsonb, p_step text, p_section text, p_data jsonb) returns setof text
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_block jsonb := recipe.step_node(p_content, p_step) -> 'block';
  d       jsonb;
  f       jsonb;
begin
  if coalesce(v_block ->> 'type', '') not like 'LIB-%' then
    return;
  end if;
  d := recipe.library_definition(p_content, v_block);
  if d ->> 'category' = 'PACKAGING' then
    return;
  end if;
  for f in select x from jsonb_array_elements(case when jsonb_typeof(d -> 'sections') = 'array' then d -> 'sections' else '[]'::jsonb end) sec,
                         jsonb_array_elements(case when jsonb_typeof(sec -> 'fields') = 'array' then sec -> 'fields' else '[]'::jsonb end) x
            where sec ->> 'id' = p_section and x ->> 'type' = 'EQUIPMENT' and x ->> 'kind' = 'LINE' loop
    if jsonb_typeof(p_data -> (f ->> 'id')) = 'string' then
      return next p_data ->> (f ->> 'id');
    end if;
  end loop;
end
$$;

create function plant.aps_us_text(p bigint) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select to_char((timestamptz 'epoch' + p * interval '1 microsecond') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

create function plant.aps_interval_problem(p_batch uuid, p_content jsonb, p_type text, p_command jsonb, p_state jsonb, p_now_us bigint) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_code  text;
  v_unit  uuid;
  v_until bigint;
  v_key   text;
  e       jsonb;
begin
  if p_type = 'RECORD_ENTRY' then
    for v_code in select plant.aps_entry_lines(p_content, p_command ->> 'step', p_command -> 'entry' ->> 'kind', p_command -> 'entry') loop
      select q.id into v_unit from plant.equipment q where q.code = v_code;
      if v_unit is null then
        continue;
      end if;
      if plant.aps_interval_days(v_unit) is null then
        return format('EBMR-PLANT-092 the filling line %s has no APS interval in force: the firm sets the interval between its aseptic process simulations, approved by QA, before the line fills an aseptic batch (Schedule M Part II 5.5; 21 CFR 211.113(b))', v_code);
      end if;
      v_until := plant.aps_valid_until_us(v_code, p_now_us);
      if v_until is null then
        return format('EBMR-PLANT-093 the filling line %s has no passing aseptic process simulation on record, so it does not fill an aseptic batch (Schedule M Part II 5.5; 21 CFR 211.113(b))', v_code);
      end if;
      if v_until <= p_now_us then
        return format('EBMR-PLANT-093 the aseptic process simulation of the filling line %s was valid until %s: the line does not fill an aseptic batch until a media fill passes on it again (Schedule M Part II 5.5; 21 CFR 211.113(b))', v_code, plant.aps_us_text(v_until));
      end if;
    end loop;
    return null;
  end if;
  if p_type = 'SIGN_PERFORMED' then
    v_key := recipe.row_step_key('COMMAND', p_command);
    for e in select x.value from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x
              where x.value ->> 'stepKey' = v_key order by x.key loop
      for v_code in select plant.aps_entry_lines(p_content, p_command ->> 'step', e ->> 'kind', e -> 'data') loop
        if not exists (select 1 from plant.equipment q where q.code = v_code) then
          continue;
        end if;
        v_until := plant.aps_valid_until_us(v_code, p_now_us);
        if v_until is not null and v_until > p_now_us then
          continue;
        end if;
        if not exists (select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'exceptions') = 'object' then p_state -> 'exceptions' else '{}'::jsonb end) x
                        where x.value -> 'source' ->> 'stepKey' = v_key
                          and x.value ->> 'severity' in ('ACTION', 'CRITICAL')
                          and x.value -> 'deviationRequired' = 'true'::jsonb
                          and recipe.micros_of(x.value -> 'raisedAt') >= coalesce(v_until, recipe.micros_of(e -> 'recordedAt'))
                          and jsonb_typeof(x.value -> 'deviation') = 'object'
                          and x.value ->> 'status' = 'DISPOSITIONED'
                          and x.value -> 'disposition' ->> 'outcome' = 'DEVIATION_RAISED') then
          return format('EBMR-PLANT-094 the aseptic process simulation of the filling line %s %s, during the filling of step %s: an ACTION exception at the step (the system raises it at the sign-off; it requires a deviation) must be dispositioned by QA under the linked deviation before the step is signed (Schedule M Part II 5.5; 21 CFR 211.113(b); only QA dispositions it, 21 CFR 211.22, 211.192)',
                        v_code, case when v_until is null then 'is no longer valid' else 'was valid until ' || plant.aps_us_text(v_until) end, v_key);
        end if;
      end loop;
    end loop;
  end if;
  return null;
end
$$;

create function plant.aps_interval_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.accepted is not true or new.command_type not in ('RECORD_ENTRY', 'SIGN_PERFORMED') then
    return new;
  end if;
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not plant.aps_interval_scope(new.batch_id, v_content) then
    return new;
  end if;
  v_problem := plant.aps_interval_problem(new.batch_id, v_content, new.command_type, new.command,
                                          (select s.state from recipe.execution_state s where s.batch_id = new.batch_id), new.now_us);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  return new;
end
$$;
create trigger ad_plant_aps_interval before insert on recipe.execution_command for each row execute function plant.aps_interval_check();

-- (c) Lead ruling, 15 November 2026: the engine raises the lapse itself. The facts the server states in a SIGN_PERFORMED
-- command (and its PREPARE target) for the step's PERFORMED attempt: each line the step's entries set, in a batch in
-- scope, with the end of its APS validity at p_at_us in engine microseconds (as text; null without a valid APS). The
-- engine raises LIB_APS_LAPSED (an ACTION exception requiring a deviation, recipe-core library/block-version.ts) for a
-- line whose validity ended at or before the sign-off; the trigger above refuses the sign-off without it (-094), so a
-- fact misstated by a writer is still caught here. Empty out of scope.
create function plant.aps_sign_off_facts(p_batch uuid, p_step text, p_step_key text, p_at_us bigint) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_out     jsonb := '{}'::jsonb;
  e         jsonb;
  v_code    text;
begin
  if not plant.aps_interval_scope(p_batch, v_content) then
    return v_out;
  end if;
  for e in select x.value from recipe.execution_state s,
                  jsonb_each(case when jsonb_typeof(s.state -> 'entries') = 'object' then s.state -> 'entries' else '{}'::jsonb end) x
            where s.batch_id = p_batch and x.value ->> 'stepKey' = p_step_key order by x.key loop
    for v_code in select plant.aps_entry_lines(v_content, p_step, e ->> 'kind', e -> 'data') loop
      if exists (select 1 from plant.equipment q where q.code = v_code) then
        v_out := v_out || jsonb_build_object(v_code, plant.aps_valid_until_us(v_code, p_at_us)::text);
      end if;
    end loop;
  end loop;
  return v_out;
end
$$;

revoke all on function plant.aps_interval_approval_guard(), plant.propose_aps_interval(text, integer, text), plant.approve_aps_interval(uuid),
  plant.aps_interval_days(uuid), plant.aps_valid_until_us(text, bigint), plant.aps_interval_scope(uuid, jsonb),
  plant.aps_entry_lines(jsonb, text, text, jsonb), plant.aps_us_text(bigint),
  plant.aps_interval_problem(uuid, jsonb, text, jsonb, jsonb, bigint), plant.aps_interval_check(),
  plant.aps_sign_off_facts(uuid, text, text, bigint) from public;
grant execute on function plant.propose_aps_interval(text, integer, text), plant.approve_aps_interval(uuid),
  plant.aps_sign_off_facts(uuid, text, text, bigint) to ebmr_app;

reset role;
