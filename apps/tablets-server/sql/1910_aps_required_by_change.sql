-- ST-29 minimum (owner decision via the lead, 5 November 2026: Annex 1 9.48-9.49 and Schedule M 5.3-5.7 triggers only):
-- a significant change to the HVAC system, the equipment or the process of an aseptic line is followed by a repeat of
-- the process simulation (Annex 1 9.38; revised Schedule M Part II 5.5). The firm names, on the change record, the
-- filling lines for which the change requires an APS; when QA approves the record, the database withdraws each line's
-- qualification, so the existing fitness guard refuses the line in a step until QA records it QUALIFIED again (after
-- the APS), through plant.record_equipment_event as before.
--
-- Handbook: modules/tablets-server.md
--
--   plant.aps_required_line   insert-only (audited, aggregate config_change_record): a change record ↔ a unit for which
--                             the change requires an APS, by whom and when. Nothing is pre-filled: rows come only from
--                             the firm's own list on the change record.
--   plant.require_aps_after_change(number, codes)
--                             CONFIG.CHANGE_RAISE: lists the units; the record must be OPEN (not yet approved), each code
--                             a known unit not retired, each unit listed once (EBMR-CFG-020).
--   plant.aps_line_open_guard()  BEFORE INSERT on plant.aps_required_line: whoever writes it, a row is accepted only while
--                             its change record is OPEN (EBMR-CFG-020).
--   plant.withdraw_aps_lines()   AFTER INSERT of the APPROVED event of a change record: each listed unit not retired gets
--                             QUALIFICATION_WITHDRAWN, reference = the change number, detail "APS required by change
--                             <number>", recorded as the approver; plant.equipment_fitness then answers NOT_QUALIFIED.
--   platform.change_record_content(id)
--                             CREATE OR REPLACE of kernel 1195: a record with listed units carries them (aps_lines, sorted
--                             codes) in its signed content, so QA's approval signature covers the list and a list changed
--                             after the signature fails the approval. A record without a list keeps 1195's content exactly.

set local role ebmr_owner;

create table plant.aps_required_line (
  change_record_id   uuid not null references platform.change_record (id),
  equipment_id       uuid not null references plant.equipment (id),
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  primary key (change_record_id, equipment_id)
);
create index aps_required_line_by_equipment on plant.aps_required_line (equipment_id);
revoke all on plant.aps_required_line from public;
grant select on plant.aps_required_line to ebmr_app;
select platform.enforce_db_time('plant.aps_required_line', array['recorded_at']);
select kernel.register_audited_table('plant.aps_required_line', 'config_change_record', 'change_record_id', true);

-- Whoever writes the row: the change record is still OPEN.
create function plant.aps_line_open_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_state text := platform.change_record_state(new.change_record_id);
begin
  if v_state is distinct from 'OPEN' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-CFG-020 the units a change requires an APS for are named while its change record is open, before approval; this record is %s (ST-29)',
      coalesce(v_state, 'unknown'));
  end if;
  return new;
end
$$;
create trigger aa_aps_line_open before insert on plant.aps_required_line for each row execute function plant.aps_line_open_guard();

-- Lists the units (equipment codes) for which change record p_number requires an APS. Returns how many were listed.
create function plant.require_aps_after_change(p_number text, p_codes text[]) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
declare
  v_actor jsonb;
  r       platform.change_record;
  v_code  text;
  e       plant.equipment;
  v_n     integer := 0;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONFIG.CHANGE_RAISE', '{}'::jsonb);
  select * into r from platform.change_record c where c.number = p_number for update;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-002 change record %s does not exist (DI-09)', p_number);
  end if;
  if platform.change_record_state(r.id) <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-CFG-020 change record %s is %s: the units it requires an APS for are named before approval (ST-29)', p_number, platform.change_record_state(r.id));
  end if;
  if p_codes is null or cardinality(p_codes) = 0 then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-020 change record %s: name at least one unit that needs an APS (ST-29)', p_number);
  end if;
  for v_code in select distinct btrim(x) from unnest(p_codes) x order by 1 loop
    select * into e from plant.equipment q where q.code = v_code;
    if e.id is null then
      raise exception using errcode = 'P0001', message = format('EBMR-CFG-020 change record %s: unknown equipment unit %s (ST-29)', p_number, coalesce(v_code, 'null'));
    end if;
    if plant.latest_event_of(e.id, array['RETIRED']) is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-CFG-020 change record %s: %s is retired (ST-29)', p_number, e.code);
    end if;
    if exists (select 1 from plant.aps_required_line a where a.change_record_id = r.id and a.equipment_id = e.id) then
      raise exception using errcode = 'P0001', message = format('EBMR-CFG-020 change record %s already names %s (ST-29)', p_number, e.code);
    end if;
    insert into plant.aps_required_line (change_record_id, equipment_id, person_id, account_id)
    values (r.id, e.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- On approval: each listed unit loses its qualification until QA records it QUALIFIED again (after the APS).
create function plant.withdraw_aps_lines() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_number text;
begin
  select c.number into v_number from platform.change_record c where c.id = new.change_record_id;
  insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id)
  select a.equipment_id, 'QUALIFICATION_WITHDRAWN', v_number, format('APS required by change %s', v_number), new.person_id, new.account_id
    from plant.aps_required_line a
   where a.change_record_id = new.change_record_id
     and plant.latest_event_of(a.equipment_id, array['RETIRED']) is null
   order by a.equipment_id;
  return null;
end
$$;
create trigger zy_aps_withdraw_on_approval after insert on platform.change_record_event
  for each row when (new.event = 'APPROVED') execute function plant.withdraw_aps_lines();

-- Kernel 1195's content, with the listed units (only when there are some) in the signed content.
create or replace function platform.change_record_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  r       platform.change_record;
  v_lines jsonb;
  v_c     jsonb;
begin
  select * into r from platform.change_record c where c.number = p_id;
  if r.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_c := jsonb_build_object('number', r.number, 'title', r.title, 'description', r.description, 'areas', to_jsonb(r.areas),
                            'raised_by', r.raised_by_person, 'raised_at', to_char(r.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  select jsonb_agg(e.code order by e.code) into v_lines
    from plant.aps_required_line a join plant.equipment e on e.id = a.equipment_id where a.change_record_id = r.id;
  if v_lines is not null then
    v_c := v_c || jsonb_build_object('aps_lines', v_lines);
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', v_c,
    'state', platform.change_record_state(r.id),
    'entered_by', jsonb_build_array(r.raised_by_person));
end
$$;

revoke all on function plant.require_aps_after_change(text, text[]), plant.aps_line_open_guard(), plant.withdraw_aps_lines() from public;
grant execute on function plant.require_aps_after_change(text, text[]) to ebmr_app;

reset role;
