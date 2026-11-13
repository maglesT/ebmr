-- ST-33, lead rulings on tablets 1911 (13 November 2026): the failed media fill is found by a property of its block, not
-- its code; the withdrawal records the batches at risk; QA's review of them, with the repeat simulations, comes before
-- the line is qualified again (EU only, as the withdrawal itself).
--
-- Handbook: modules/tablets-server.md
--
-- EU GMP Annex 1 9.46, paraphrased: a failed APS calls for an investigation, a prompt review of the records of the batches
-- made since the last successful APS with a risk assessment of a sterility breach for each, and, before the process is
-- back in routine use, successful repeat simulations, normally at least three in a row.
--
-- (a) Decision 0026 (a firm's own QA-approved block works without software): a step counts as a media-fill reading when
--     its block is a library block, APPROVED in the library (recipe.library_block_approval, as recipe-core 1892), whose
--     approved definition carries the role APS_READING; the count of contaminated units is the value of the NUMBER field
--     that definition marks `contaminatedCount: true` in the entry's section (library/check-definition: exactly one such
--     field, decimals 0, LIB-APS-READING). No block code or field id is read.
--
--   plant.aps_reading_field(content, state, entry)
--                             the id of the marked count field when the entry is a section of an approved APS_READING
--                             block holding it; NULL otherwise.
--   plant.line_uses(content, state)
--                             every (code, recordedAt in microseconds) an EQUIPMENT field of kind LINE of a library step
--                             of the state names (as 1911 read them).
--   plant.aps_failure_lines   CREATE OR REPLACE of 1911: as before (EU masters only, a count above zero added or raised
--                             from zero, the LINE units not retired), with the reading found by aps_reading_field.
--   plant.withdraw_lines_on_aps_failure()
--                             CREATE OR REPLACE of 1911: as before, for any entry the row adds or changes (not only a
--                             section named 'reading'), and with each withdrawal recorded in plant.aps_failure_withdrawal
--                             and its impact list in plant.aps_failure_impact.
--
-- (b) The impact list. plant.line_batch_uses(code): each batch whose execution state names the unit, whole and in an
--     EQUIPMENT field of kind LINE as 1911 reads them (never a code another code starts with), with its last such use and whether it holds an APS_READING reading of zero (a successful APS on the line). At a
--     withdrawal, the last successful APS is the latest such batch (by its use of the line) other than the failed one; the
--     list is every other batch whose last use of the line is after that one's use, or, with no successful APS on record,
--     every batch that recorded the line. The failed media fill itself is NOT listed: it is the withdrawal's own batch
--     (aps_failure_withdrawal.failed_batch_number). Other media fills in the window are listed like any batch.
--
--   plant.aps_failure_withdrawal  insert-only (audited, aggregate plant_equipment): an ST-33 withdrawal event, its unit,
--                             the failed batch and the last successful APS batch (NULL: none on record).
--   plant.aps_failure_impact  insert-only (audited): the withdrawal's batches, with each one's last use of the line.
--
-- (c) QA's review and the repeat simulations.
--
--   plant.aps_failure_review  insert-only (audited): one per withdrawal: the risk-assessment reference covering the impact
--                             list (A1 9.46(iv)), the firm's references of the successful repeat APS runs (A1 9.46(iii)),
--                             and, with fewer than three, the firm's justification. Checks on the table hold whoever writes
--                             it: a non-blank reference, one to fifty distinct non-blank run references, three or more or a
--                             non-blank justification.
--   plant.record_aps_failure_review(line code, risk_assessment_ref, repeat_aps_refs, justification)
--                             RECORD.QA_REVIEW. Only for the unit's open ST-33 withdrawal (its latest qualification event,
--                             not yet reviewed; EBMR-PLANT-070); the reference not blank (EBMR-PLANT-071); the run
--                             references at least one, none blank, no repeat, none the failed batch's own number
--                             (EBMR-PLANT-072); fewer than three only with a justification (EBMR-PLANT-073). No value is
--                             defaulted.
--   plant.aps_requalification_guard()
--                             BEFORE INSERT of a QUALIFIED event on plant.equipment_event, whoever writes it: refused while
--                             the unit's latest qualification event is an ST-33 withdrawal without its review
--                             (EBMR-PLANT-074). An ST-29 withdrawal (1910) and any other withdrawal are not affected.
--
-- Not built (ST-33's other consequences): the quarantine of product made after the failure, the release block of the
-- listed batches, the investigation record; the review's reference stands for the investigation's risk assessment.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------------------------- (a)

create function plant.aps_reading_field(p_content jsonb, p_state jsonb, p_entry jsonb) returns text
language sql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
  select f ->> 'id'
    from (select recipe.step_node(p_content, p_state -> 'steps' -> (p_entry ->> 'stepKey') ->> 'step') -> 'block' as blk) n
    join recipe.library_block lb on 'LIB-' || lb.code = n.blk ->> 'type' and lb.version::text = n.blk ->> 'version'
    join recipe.library_block_approval a on a.block_id = lb.id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(lb.definition -> 'sections') = 'array' then lb.definition -> 'sections' else '[]'::jsonb end) sec
    cross join lateral jsonb_array_elements(case when jsonb_typeof(sec -> 'fields') = 'array' then sec -> 'fields' else '[]'::jsonb end) f
   where jsonb_typeof(n.blk) = 'object'
     and jsonb_typeof(lb.definition -> 'roles') = 'array'
     and lb.definition -> 'roles' ? 'APS_READING'
     and sec ->> 'id' = p_entry ->> 'kind'
     and f ->> 'type' = 'NUMBER'
     and f -> 'contaminatedCount' = 'true'::jsonb
   limit 1
$$;

-- A count as the engine stores it (a decimal string); NULL when it is not one.
create function plant.aps_count(p text) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p ~ '^[0-9]+(\.[0-9]+)?$' then p::numeric end
$$;

create function plant.line_uses(p_content jsonb, p_state jsonb) returns table (code text, used_us bigint)
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  k      text;
  e      jsonb;
  v_node jsonb;
  d      jsonb;
  f      jsonb;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x order by x.key loop
    v_node := recipe.step_node(p_content, p_state -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    if coalesce(v_node -> 'block' ->> 'type', '') not like 'LIB-%' then
      continue;
    end if;
    d := recipe.library_definition(p_content, v_node -> 'block');
    for f in select x from jsonb_array_elements(coalesce(d -> 'sections', '[]'::jsonb)) sec, jsonb_array_elements(coalesce(sec -> 'fields', '[]'::jsonb)) x
              where sec ->> 'id' = e ->> 'kind' and x ->> 'type' = 'EQUIPMENT' and x ->> 'kind' = 'LINE' loop
      if e -> 'data' ->> (f ->> 'id') is not null then
        code := e -> 'data' ->> (f ->> 'id');
        used_us := recipe.micros_of(e -> 'recordedAt');
        return next;
      end if;
    end loop;
  end loop;
end
$$;

create or replace function plant.aps_failure_lines(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns uuid[]
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1       jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  v_field  text;
  v_failed boolean := false;
  v_code   text;
  v_units  uuid[] := '{}';
  v_id     uuid;
begin
  if jsonb_typeof(p_content -> 'header' -> 'marketSet') is distinct from 'array' or not (p_content -> 'header' -> 'marketSet') ? 'EU' then
    return v_units;
  end if;
  -- A media-fill reading with a contaminated unit, added by this row (or changed to one by it).
  for k, e in select x.key, x.value from jsonb_each(e1) x loop
    if (e0 -> k) is not distinct from e then
      continue;
    end if;
    v_field := plant.aps_reading_field(p_content, p_new, e);
    if v_field is null or coalesce(plant.aps_count(e -> 'data' ->> v_field), 0) <= 0 then
      continue;
    end if;
    if coalesce(plant.aps_count(e0 -> k -> 'data' ->> v_field), 0) > 0 then
      continue;
    end if;
    v_failed := true;
    exit;
  end loop;
  if not v_failed then
    return v_units;
  end if;
  -- The lines the batch filled on: every EQUIPMENT field of kind LINE its library steps recorded.
  for v_code in select u.code from plant.line_uses(p_content, p_new) u loop
    select q.id into v_id from plant.equipment q where q.code = v_code;
    if v_id is not null and not v_id = any (v_units) and plant.latest_event_of(v_id, array['RETIRED']) is null then
      v_units := v_units || v_id;
    end if;
  end loop;
  return v_units;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------- (b)

create function plant.line_batch_uses(p_code text) returns table (batch_id uuid, batch_number text, used_us bigint, good_aps boolean)
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  r         record;
  v_content jsonb;
  e         jsonb;
  v_field   text;
begin
  -- The text test only narrows the states to read (the quoted JSON string, so LINE-1 does not match LINE-10); which
  -- batches recorded the unit is decided by plant.line_uses, the EQUIPMENT fields of kind LINE 1911 reads, compared whole.
  for r in select s.batch_id as id, s.state, b.batch_number as number
             from recipe.execution_state s join recipe.batch_execution b on b.id = s.batch_id
            where strpos(s.state::text, to_jsonb(p_code)::text) > 0
            order by s.batch_id loop
    v_content := recipe.batch_mbr_content(r.id);
    select max(u.used_us) into used_us from plant.line_uses(v_content, r.state) u where u.code = p_code;
    if used_us is null then
      continue;
    end if;
    good_aps := false;
    for e in select x.value from jsonb_each(case when jsonb_typeof(r.state -> 'entries') = 'object' then r.state -> 'entries' else '{}'::jsonb end) x loop
      v_field := plant.aps_reading_field(v_content, r.state, e);
      if v_field is not null and plant.aps_count(e -> 'data' ->> v_field) = 0 then
        good_aps := true;
        exit;
      end if;
    end loop;
    batch_id := r.id;
    batch_number := r.number;
    return next;
  end loop;
end
$$;

create table plant.aps_failure_withdrawal (
  event_id             uuid primary key references plant.equipment_event (id),
  equipment_id         uuid not null references plant.equipment (id),
  failed_batch_id      uuid not null,
  failed_batch_number  text not null,
  last_good_aps_batch  text,
  recorded_at          timestamptz not null default clock_timestamp()
);
create index aps_failure_withdrawal_by_equipment on plant.aps_failure_withdrawal (equipment_id);
revoke all on plant.aps_failure_withdrawal from public;
grant select on plant.aps_failure_withdrawal to ebmr_app;
select platform.enforce_db_time('plant.aps_failure_withdrawal', array['recorded_at']);
select kernel.register_audited_table('plant.aps_failure_withdrawal', 'plant_equipment', 'equipment_id', true);

create table plant.aps_failure_impact (
  event_id      uuid not null references plant.aps_failure_withdrawal (event_id),
  equipment_id  uuid not null references plant.equipment (id),
  batch_id      uuid not null,
  batch_number  text not null,
  last_used_at  timestamptz not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  primary key (event_id, batch_id)
);
revoke all on plant.aps_failure_impact from public;
grant select on plant.aps_failure_impact to ebmr_app;
select platform.enforce_db_time('plant.aps_failure_impact', array['recorded_at']);
select kernel.register_audited_table('plant.aps_failure_impact', 'plant_equipment', 'equipment_id', true);

create or replace function plant.withdraw_lines_on_aps_failure() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_units  uuid[];
  v_number text;
  c        recipe.execution_command;
  v_unit   uuid;
  v_code   text;
  v_last   plant.equipment_event;
  v_event  uuid;
  v_uses   jsonb;
  v_good   record;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where (old.state -> 'entries' -> x.key) is distinct from x.value) then
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
    values (v_unit, 'QUALIFICATION_WITHDRAWN', v_number, v_number, 'APS failed: repeat APS required (A1 9.46)', c.actor_person, c.actor_account)
    returning id into v_event;
    -- The impact list: the batches on the line since its last successful APS (all of them when none is on record).
    select q.code into v_code from plant.equipment q where q.id = v_unit;
    select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) into v_uses from plant.line_batch_uses(v_code) u where u.batch_id <> new.batch_id;
    select u.batch_number, u.used_us into v_good
      from jsonb_to_recordset(v_uses) u (batch_id uuid, batch_number text, used_us bigint, good_aps boolean)
     where u.good_aps order by u.used_us desc, u.batch_number desc limit 1;
    insert into plant.aps_failure_withdrawal (event_id, equipment_id, failed_batch_id, failed_batch_number, last_good_aps_batch)
    values (v_event, v_unit, new.batch_id, v_number, v_good.batch_number);
    insert into plant.aps_failure_impact (event_id, equipment_id, batch_id, batch_number, last_used_at)
    select v_event, v_unit, u.batch_id, u.batch_number, timestamptz 'epoch' + u.used_us * interval '1 microsecond'
      from jsonb_to_recordset(v_uses) u (batch_id uuid, batch_number text, used_us bigint, good_aps boolean)
     where v_good.used_us is null or u.used_us > v_good.used_us
     order by u.used_us, u.batch_id;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------- (c)

-- One to fifty run references, none blank or padded, no repeat.
create function plant.aps_refs_well_formed(p text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p is not null and cardinality(p) between 1 and 50 and array_ndims(p) = 1
     and not exists (select 1 from unnest(p) x where x is null or x = '' or x <> btrim(x))
     and (select count(distinct upper(x)) from unnest(p) x) = cardinality(p)
$$;

create table plant.aps_failure_review (
  event_id             uuid primary key references plant.aps_failure_withdrawal (event_id),
  equipment_id         uuid not null references plant.equipment (id),
  risk_assessment_ref  text not null check (risk_assessment_ref = btrim(risk_assessment_ref) and risk_assessment_ref <> '' and length(risk_assessment_ref) <= 128),
  repeat_aps_refs      text[] not null check (plant.aps_refs_well_formed(repeat_aps_refs)),
  justification        text check (justification is null or (justification = btrim(justification) and justification <> '' and length(justification) <= 2000)),
  person_id            uuid not null,
  account_id           uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  constraint aps_failure_review_three_or_justified check (cardinality(repeat_aps_refs) >= 3 or justification is not null)
);
revoke all on plant.aps_failure_review from public;
grant select on plant.aps_failure_review to ebmr_app;
select platform.enforce_db_time('plant.aps_failure_review', array['recorded_at']);
select kernel.register_audited_table('plant.aps_failure_review', 'plant_equipment', 'equipment_id', true);

-- The unit's latest qualification event when it is an ST-33 withdrawal (the row of plant.aps_failure_withdrawal); NULL otherwise.
create function plant.open_aps_failure(p_equipment uuid) returns plant.aps_failure_withdrawal
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select w.* from (select q.id from plant.equipment_event q
                    where q.equipment_id = p_equipment and q.kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN')
                    order by q.recorded_at desc, q.id desc limit 1) l
  join plant.aps_failure_withdrawal w on w.event_id = l.id
$$;

create function plant.record_aps_failure_review(p_line_code text, p_risk_assessment_ref text, p_repeat_aps_refs text[], p_justification text default null)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  e       plant.equipment;
  w       plant.aps_failure_withdrawal;
  v_refs  text[];
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', '{}'::jsonb);
  e := plant.equipment_by_code(p_line_code, true);
  w := plant.open_aps_failure(e.id);
  if w.event_id is null or exists (select 1 from plant.aps_failure_review r where r.event_id = w.event_id) then
    perform plant.fail(format('%s has no open withdrawal after a failed media fill to review (ST-33; EBMR-PLANT-070)', e.code));
  end if;
  if plant.is_blank(p_risk_assessment_ref) then
    perform plant.fail(format('The review of the batches made on %s since its last successful APS cites the reference of their risk assessment (A1 9.46; ST-33; EBMR-PLANT-071)', e.code));
  end if;
  select coalesce(array_agg(btrim(x) order by o), '{}') into v_refs from unnest(p_repeat_aps_refs) with ordinality u (x, o);
  if cardinality(v_refs) = 0 then
    perform plant.fail('The review cites the successful repeat APS runs: at least one reference (A1 9.46; ST-33; EBMR-PLANT-072)');
  end if;
  if exists (select 1 from unnest(v_refs) x where x is null or x = '') then
    perform plant.fail('A repeat APS run reference is blank (ST-33; EBMR-PLANT-072)');
  end if;
  if (select count(distinct upper(x)) from unnest(v_refs) x) <> cardinality(v_refs) then
    perform plant.fail('Each repeat APS run is cited once: a reference is repeated (ST-33; EBMR-PLANT-072)');
  end if;
  if exists (select 1 from unnest(v_refs) x where upper(x) = upper(w.failed_batch_number)) then
    perform plant.fail(format('The failed media fill %s is not a repeat of itself (ST-33; EBMR-PLANT-072)', w.failed_batch_number));
  end if;
  if cardinality(v_refs) < 3 and plant.is_blank(p_justification) then
    perform plant.fail(format('%s successful repeat APS run(s) cited: fewer than three, normally the minimum, need the firm''s justification (A1 9.46; ST-33; EBMR-PLANT-073)', cardinality(v_refs)));
  end if;
  insert into plant.aps_failure_review (event_id, equipment_id, risk_assessment_ref, repeat_aps_refs, justification, person_id, account_id)
  values (w.event_id, e.id, btrim(p_risk_assessment_ref), v_refs, nullif(btrim(p_justification), ''), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return w.event_id;
end
$$;

-- Whoever writes the QUALIFIED event: an ST-33 withdrawal is reviewed first.
create function plant.aps_requalification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  w plant.aps_failure_withdrawal := plant.open_aps_failure(new.equipment_id);
begin
  if w.event_id is not null and not exists (select 1 from plant.aps_failure_review r where r.event_id = w.event_id) then
    raise exception using errcode = 'P0001', message = format(
      'The unit''s qualification was withdrawn after the failed media fill %s: QA records the review of the batches since the last successful APS, with the repeat APS runs, before it is qualified again (A1 9.46; ST-33; EBMR-PLANT-074)',
      w.failed_batch_number);
  end if;
  return new;
end
$$;
create trigger ab_aps_requalification before insert on plant.equipment_event
  for each row when (new.kind = 'QUALIFIED') execute function plant.aps_requalification_guard();

revoke all on function plant.aps_reading_field(jsonb, jsonb, jsonb), plant.aps_count(text), plant.line_uses(jsonb, jsonb),
  plant.line_batch_uses(text), plant.aps_refs_well_formed(text[]), plant.open_aps_failure(uuid),
  plant.record_aps_failure_review(text, text, text[], text), plant.aps_requalification_guard() from public;
grant execute on function plant.record_aps_failure_review(text, text, text[], text), plant.open_aps_failure(uuid) to ebmr_app;

reset role;
