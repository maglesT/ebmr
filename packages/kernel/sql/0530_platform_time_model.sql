-- Platform services, part 4: the two-timestamp model for business events, late entries, site
-- time and a demonstration table (build outline 5.6; controls DI-27, DI-28 context; INV-16).
--
-- Every business event has two times:
--   recorded_at   set by the database clock when the entry is committed; authoritative for
--                 ordering and audit; the application can never choose it (INV-16).
--   occurred_at   optional claimed or source time of the event, with a trust level:
--                 DEVICE_SYNCED    instrument clock that is synchronised to the trusted source
--                 DEVICE_UNSYNCED  instrument clock that is not synchronised
--                 USER_CLAIMED     a person states when the event happened
--                 PAPER            back-entry from a paper contingency record
-- occurred_at must lie between the step start and recorded_at. Time constraints use occurred_at
-- only when its trust is DEVICE_SYNCED, otherwise recorded_at, and the row records which one
-- was used. A person-claimed time (USER_CLAIMED, PAPER) makes the entry a late entry: it needs a
-- reason, is flagged for review, and beyond the late-entry window it needs a supervisor
-- co-signature. Status guards of a late entry are evaluated at both instants
-- (platform.guard_instants); a failure at either raises an exception in the caller's domain.

set local role ebmr_owner;

create domain platform.time_trust as text
  check (value in ('DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER'));

create type platform.time_basis_choice as (
  basis     text,          -- OCCURRED_AT or RECORDED_AT
  basis_at  timestamptz
);

create type platform.late_entry_assessment as (
  is_late         boolean,
  window_ends_at  timestamptz,
  beyond_window   boolean
);

-- ---------------------------------------------------------------------------------------------
-- Checks
-- ---------------------------------------------------------------------------------------------

create function platform.check_occurred_at(p_occurred_at timestamptz, p_trust text, p_step_started_at timestamptz,
                                           p_recorded_at timestamptz) returns void
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if p_occurred_at is null and p_trust is null then
    return;
  end if;
  if p_occurred_at is null or p_trust is null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-011 an event time (occurred_at) and its trust level are given together or not at all';
  end if;
  if p_trust not in ('DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-010 unknown time trust level %s (DEVICE_SYNCED, DEVICE_UNSYNCED, USER_CLAIMED or PAPER)', p_trust);
  end if;
  if p_recorded_at is null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-012 recorded_at is required to check an event time';
  end if;
  if p_occurred_at > p_recorded_at then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-012 the event time %s is later than the time the entry is recorded (%s)', p_occurred_at, p_recorded_at);
  end if;
  if p_step_started_at is not null and p_occurred_at < p_step_started_at then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-013 the event time %s is before the step started (%s)', p_occurred_at, p_step_started_at);
  end if;
end
$$;

-- Entries of one step are in order: an entry's event time is not earlier than that of an earlier
-- item of the step and not later than that of a later item already recorded.
create function platform.check_step_order(p_event_at timestamptz, p_previous_at timestamptz, p_next_at timestamptz) returns void
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if p_previous_at is not null and p_event_at < p_previous_at then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-014 the event time %s is earlier than that of an earlier item of the step (%s)', p_event_at, p_previous_at);
  end if;
  if p_next_at is not null and p_event_at > p_next_at then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-014 the event time %s is later than that of a later item of the step (%s)', p_event_at, p_next_at);
  end if;
end
$$;

-- Which time drives time constraints (outline 5.6).
create function platform.time_basis(p_occurred_at timestamptz, p_trust text, p_recorded_at timestamptz)
returns platform.time_basis_choice
language sql immutable set search_path = pg_catalog, platform as $$
  select case when p_occurred_at is not null and p_trust = 'DEVICE_SYNCED'
              then row('OCCURRED_AT', p_occurred_at)::platform.time_basis_choice
              else row('RECORDED_AT', p_recorded_at)::platform.time_basis_choice end
$$;

create function platform.is_late_entry(p_occurred_at timestamptz, p_trust text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p_occurred_at is not null and coalesce(p_trust in ('USER_CLAIMED', 'PAPER'), false)
$$;

-- End of the late-entry window (policy time.late_entry_window_mode / _min).
create function platform.late_entry_window_ends_at(p_occurred_at timestamptz, p_planned_step_end timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = pg_catalog, platform as $$
begin
  if platform.setting_text('time.late_entry_window_mode') = 'PLANNED_STEP_END' and p_planned_step_end is not null then
    return p_planned_step_end;
  end if;
  return p_occurred_at + make_interval(mins => platform.setting_numeric('time.late_entry_window_min')::integer);
end
$$;

create function platform.assess_late_entry(p_occurred_at timestamptz, p_trust text, p_recorded_at timestamptz,
                                           p_planned_step_end timestamptz default null)
returns platform.late_entry_assessment
language plpgsql stable security definer set search_path = pg_catalog, platform as $$
declare
  v_end timestamptz;
begin
  if not platform.is_late_entry(p_occurred_at, p_trust) then
    return row(false, null, false)::platform.late_entry_assessment;
  end if;
  v_end := platform.late_entry_window_ends_at(p_occurred_at, p_planned_step_end);
  return row(true, v_end, p_recorded_at > v_end)::platform.late_entry_assessment;
end
$$;

-- Refuses a late entry without a reason, and one beyond its window without a valid supervisor
-- co-signature (meaning LATE_ENTRY_APPROVED, verified by the SIGNATURE provider).
create function platform.check_late_entry(p_assessment platform.late_entry_assessment, p_reason_code text,
                                          p_cosignature_id uuid, p_aggregate_type text, p_aggregate_id text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel as $$
begin
  if not coalesce(p_assessment.is_late, false) then
    if p_reason_code is not null or p_cosignature_id is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-PLAT-019 a late-entry reason or co-signature was given for an entry that is not late';
    end if;
    return;
  end if;
  if coalesce(trim(p_reason_code), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-015 a late entry needs a reason';
  end if;
  if p_assessment.beyond_window then
    if p_cosignature_id is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-016 the late-entry window ended at %s; a supervisor co-signature is required', p_assessment.window_ends_at);
    end if;
    perform platform.verify_signature(p_cosignature_id, 'LATE_ENTRY_APPROVED', p_aggregate_type, p_aggregate_id);
  end if;
end
$$;

-- The instants at which status guards must be evaluated: the recorded time always, and the
-- claimed event time as well when there is one. The caller evaluates each guard at each instant
-- and raises an exception if any evaluation fails (never a silent pass, never a silent block).
create function platform.guard_instants(p_occurred_at timestamptz, p_trust text, p_recorded_at timestamptz)
returns table (instant_role text, at timestamptz)
language sql immutable set search_path = pg_catalog as $$
  select 'OCCURRED_AT', p_occurred_at where p_occurred_at is not null and p_occurred_at <> p_recorded_at
  union all
  select 'RECORDED_AT', p_recorded_at
$$;

-- ---------------------------------------------------------------------------------------------
-- Site time (storage in UTC; display in the site zone with its offset)
-- ---------------------------------------------------------------------------------------------

create function platform.is_valid_time_zone(p_zone text) returns boolean
language sql stable set search_path = pg_catalog as $$
  select p_zone is not null and exists (select 1 from pg_timezone_names where name = p_zone)
$$;

create function platform.assert_time_zone(p_zone text) returns void
language plpgsql stable set search_path = pg_catalog, platform as $$
begin
  if not platform.is_valid_time_zone(p_zone) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-017 %s is not an IANA time zone name', coalesce(p_zone, 'NULL'));
  end if;
end
$$;

create function platform.utc_offset(p_at timestamptz, p_zone text) returns interval
language sql stable set search_path = pg_catalog as $$
  select (p_at at time zone p_zone) - (p_at at time zone 'UTC')
$$;

create function platform.offset_text(p_offset interval) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when p_offset < interval '0' then '-' else '+' end
         || to_char(abs(extract(epoch from p_offset))::integer / 3600, 'FM00') || ':'
         || to_char((abs(extract(epoch from p_offset))::integer % 3600) / 60, 'FM00')
$$;

-- 'YYYY-MM-DD HH:MM:SS +HH:MM (Zone)': the same text as siteTime().display in src/time/site-time.ts.
create function platform.site_time_text(p_at timestamptz, p_zone text) returns text
language sql stable set search_path = pg_catalog, platform as $$
  select to_char(p_at at time zone p_zone, 'YYYY-MM-DD HH24:MI:SS') || ' ' || platform.offset_text(platform.utc_offset(p_at, p_zone))
         || ' (' || p_zone || ')'
$$;

-- Site-local calendar day for "daily" rules, manufacturing dates and shifts (outline 5.6, L-40).
create function platform.site_calendar_day(p_at timestamptz, p_zone text) returns date
language sql stable set search_path = pg_catalog as $$
  select (p_at at time zone p_zone)::date
$$;

create function platform.epoch_micros(p_at timestamptz) returns bigint
language sql immutable set search_path = pg_catalog as $$
  select (extract(epoch from p_at) * 1000000)::bigint
$$;

-- ---------------------------------------------------------------------------------------------
-- Demonstration tables: a step and its entries (the pattern later block tables follow)
-- ---------------------------------------------------------------------------------------------

create table platform.stub_step (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null,
  planned_end_at  timestamptz,
  started_at      timestamptz not null default clock_timestamp()
);

create table platform.stub_step_entry (
  id                  uuid primary key default gen_random_uuid(),
  step_id             uuid not null references platform.stub_step (id),
  item_no             integer not null check (item_no >= 1),
  value               numeric not null,
  unit                text,
  occurred_at         timestamptz,
  occurred_trust      platform.time_trust,
  late_reason_code    text,
  late_reason_text    text,
  cosignature_id      uuid,
  -- Set by the database (the application has no privilege on these columns):
  batch_id            uuid not null,
  entered_by          text not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  site_zone           text not null,
  site_utc_offset     interval not null,
  time_basis          text not null check (time_basis in ('OCCURRED_AT', 'RECORDED_AT')),
  time_basis_at       timestamptz not null,
  is_late             boolean not null,
  late_window_ends_at timestamptz,
  aggregate_seq       bigint not null,
  clock_regressed     boolean not null,
  review_flags        text[] not null,
  check ((occurred_at is null) = (occurred_trust is null)),
  check (occurred_at is null or occurred_at <= recorded_at),
  check (not is_late or late_reason_code is not null)
);
create index stub_step_entry_step on platform.stub_step_entry (step_id, item_no);

create function platform.stub_step_entry_time_model() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, kernel as $$
declare
  v_ctx    jsonb := platform.require_actor();
  v_step   platform.stub_step%rowtype;
  v_basis  platform.time_basis_choice;
  v_late   platform.late_entry_assessment;
  v_prev   timestamptz;
  v_next   timestamptz;
  v_seq    record;
  v_flags  text[] := '{}';
begin
  -- Entries of one step are serialised by locking the step row (outline 5.7: locks per step).
  select * into v_step from platform.stub_step where id = new.step_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-018 unknown step %s', new.step_id);
  end if;
  new.batch_id := v_step.batch_id;
  new.entered_by := v_ctx ->> 'person_id';
  new.site_zone := v_ctx ->> 'site_zone';
  perform platform.assert_time_zone(new.site_zone);
  new.site_utc_offset := platform.utc_offset(new.recorded_at, new.site_zone);

  perform platform.check_occurred_at(new.occurred_at, new.occurred_trust, v_step.started_at, new.recorded_at);
  v_basis := platform.time_basis(new.occurred_at, new.occurred_trust, new.recorded_at);
  new.time_basis := v_basis.basis;
  new.time_basis_at := v_basis.basis_at;

  select max(coalesce(e.occurred_at, e.recorded_at)) into v_prev from platform.stub_step_entry e where e.step_id = new.step_id and e.item_no < new.item_no;
  select min(coalesce(e.occurred_at, e.recorded_at)) into v_next from platform.stub_step_entry e where e.step_id = new.step_id and e.item_no > new.item_no;
  perform platform.check_step_order(coalesce(new.occurred_at, new.recorded_at), v_prev, v_next);

  v_late := platform.assess_late_entry(new.occurred_at, new.occurred_trust, new.recorded_at, v_step.planned_end_at);
  perform platform.check_late_entry(v_late, new.late_reason_code, new.cosignature_id, 'batch', new.batch_id::text);
  new.is_late := v_late.is_late;
  new.late_window_ends_at := v_late.window_ends_at;
  if not v_late.is_late and new.late_reason_text is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-019 a late-entry reason was given for an entry that is not late';
  end if;

  select * into v_seq from platform.next_aggregate_seq('batch', new.batch_id::text, new.recorded_at);
  new.aggregate_seq := v_seq.seq;
  new.clock_regressed := v_seq.regressed;

  if v_late.is_late then v_flags := v_flags || 'LATE_ENTRY'; end if;
  if v_late.beyond_window then v_flags := v_flags || 'LATE_BEYOND_WINDOW'; end if;
  if new.occurred_trust = 'DEVICE_UNSYNCED' then v_flags := v_flags || 'DEVICE_TIME_UNSYNCED'; end if;
  if v_seq.regressed then v_flags := v_flags || 'CLOCK_REGRESSION'; end if;
  if platform.time_fault_open() then v_flags := v_flags || 'TIME_FAULT_WINDOW'; end if;
  new.review_flags := v_flags;
  return new;
end
$$;

select platform.enforce_db_time('platform.stub_step', array['started_at']);
select platform.enforce_db_time('platform.stub_step_entry', array['recorded_at']);
-- Runs after the a0_db_time trigger, so recorded_at is already the database time.
create trigger a1_time_model before insert on platform.stub_step_entry
  for each row execute function platform.stub_step_entry_time_model();
select kernel.register_audited_table('platform.stub_step', 'batch', 'batch_id', true);
select kernel.register_audited_table('platform.stub_step_entry', 'batch', 'batch_id', true);

grant select on platform.stub_step, platform.stub_step_entry to ebmr_app;
-- Column-level grants: the application can state what happened and when it claims it happened,
-- never when it was recorded, nor any derived time field.
grant insert (batch_id, planned_end_at) on platform.stub_step to ebmr_app;
grant insert (step_id, item_no, value, unit, occurred_at, occurred_trust, late_reason_code, late_reason_text, cosignature_id)
  on platform.stub_step_entry to ebmr_app;

grant execute on function platform.check_occurred_at(timestamptz, text, timestamptz, timestamptz),
                          platform.check_step_order(timestamptz, timestamptz, timestamptz),
                          platform.time_basis(timestamptz, text, timestamptz),
                          platform.is_late_entry(timestamptz, text),
                          platform.late_entry_window_ends_at(timestamptz, timestamptz),
                          platform.assess_late_entry(timestamptz, text, timestamptz, timestamptz),
                          platform.check_late_entry(platform.late_entry_assessment, text, uuid, text, text),
                          platform.guard_instants(timestamptz, text, timestamptz),
                          platform.is_valid_time_zone(text), platform.assert_time_zone(text),
                          platform.utc_offset(timestamptz, text), platform.offset_text(interval),
                          platform.site_time_text(timestamptz, text), platform.site_calendar_day(timestamptz, text),
                          platform.epoch_micros(timestamptz) to ebmr_app;

reset role;
