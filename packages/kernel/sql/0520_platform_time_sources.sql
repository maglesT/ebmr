-- Platform services, part 3: trusted time sources, drift monitoring, time alarms and the
-- data-integrity incident request (build outline 5.6 "Drift and monotonicity"; control DI-27).
--
-- A monitor (packages/kernel/src/time/drift-monitor.ts) measures the offset of a database node's
-- clock against each active time source and calls platform.record_drift_check. That function
-- stores every sample, raises an alarm when a reachable reference shows an offset above the
-- policy threshold or when no reference can be reached, and clears the alarm once the condition
-- is gone. Offset and loss alarms request a data-integrity incident through the outbox
-- (topic incident.requested); the records module will consume it. Capture is never blocked by a
-- time fault: entries made in a fault window are flagged for review instead
-- (platform.entries_in_time_fault_windows), and the contingency path (DI-43) remains available.

set local role ebmr_owner;

-- A time source is a validated configuration item (outline 5.6; R-33): e.g. an NTP service
-- traceable to NPL India or NIC, recorded with the validation that approved it.
create table platform.time_source (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique check (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._()/-]{1,99}$'),
  kind             text not null check (kind in ('NTP')),
  endpoint         text not null check (endpoint <> ''),
  reference        text not null check (reference <> ''),
  validated_by     uuid not null,
  validation_ref   text not null check (validation_ref <> ''),
  active           boolean not null default true,
  registered_by    text not null,
  recorded_at      timestamptz not null default clock_timestamp()
);

create table platform.drift_sample (
  id             bigint generated always as identity primary key,
  check_id       uuid not null,
  node           text not null,
  source_id      uuid not null references platform.time_source (id),
  reachable      boolean not null,
  offset_s       numeric(14, 6),
  uncertainty_s  numeric(14, 6) check (uncertainty_s is null or uncertainty_s >= 0),
  threshold_s    numeric(6, 3) not null,
  within_threshold boolean not null,
  error          text,
  recorded_at    timestamptz not null default clock_timestamp(),
  check (reachable = (offset_s is not null)),
  check (within_threshold = (reachable and abs(offset_s) <= threshold_s))
);
create index drift_sample_node on platform.drift_sample (node, recorded_at);

create table platform.alarm (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('DRIFT_EXCEEDED', 'REFERENCE_LOST', 'REFERENCE_DEGRADED', 'NO_TIME_SOURCE', 'CLOCK_REGRESSION')),
  subject             text not null,
  severity            text not null check (severity in ('MINOR', 'MAJOR', 'CRITICAL')),
  incident_requested  boolean not null,
  window_start        timestamptz not null,
  check_id            uuid,
  details             jsonb not null default '{}'::jsonb,
  raised_by_person    text not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
create index alarm_subject on platform.alarm (subject, kind);

create table platform.alarm_clearance (
  alarm_id     uuid primary key references platform.alarm (id),
  subject      text not null,
  check_id     uuid,
  note         text not null,
  recorded_at  timestamptz not null default clock_timestamp()
);

-- Alarm kinds during which recorded times cannot be trusted.
create function platform.is_time_fault(p_kind text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_kind in ('DRIFT_EXCEEDED', 'REFERENCE_LOST', 'NO_TIME_SOURCE')
$$;

-- Start of the window of doubt for a node: the last sample within threshold, else the node's
-- first sample, else now.
create function platform.time_window_start(p_node text, p_exclude_check uuid default null) returns timestamptz
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select coalesce(
    (select max(recorded_at) from platform.drift_sample
      where node = p_node and within_threshold and check_id is distinct from p_exclude_check),
    (select min(recorded_at) from platform.drift_sample where node = p_node),
    clock_timestamp())
$$;

create function platform.raise_alarm(p_kind text, p_subject text, p_severity text, p_incident boolean,
                                     p_details jsonb, p_check_id uuid default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
  v_id  uuid;
begin
  if coalesce(trim(p_subject), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-031 an alarm needs a subject (e.g. the database node)';
  end if;
  insert into platform.alarm (kind, subject, severity, incident_requested, window_start, check_id, details, raised_by_person)
  values (p_kind, p_subject, p_severity, p_incident, platform.time_window_start(p_subject, p_check_id), p_check_id,
          coalesce(p_details, '{}'::jsonb), v_ctx ->> 'person_id')
  returning id into v_id;
  return v_id;
end
$$;

-- Hook to the data-integrity incident register (records module). For now it records the alarm
-- and emits outbox message incident.requested; the lead wires the consumer to records.raise_incident.
create function platform.raise_time_incident(p_kind text, p_node text, p_severity text, p_details jsonb default '{}'::jsonb,
                                             p_check_id uuid default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_alarm platform.alarm%rowtype;
  v_id    uuid;
begin
  v_id := platform.raise_alarm(p_kind, p_node, p_severity, true, p_details, p_check_id);
  select * into v_alarm from platform.alarm where id = v_id;
  perform platform.enqueue_message('incident.requested', 'time_node:' || p_node, jsonb_build_object(
    'incident_type', 'DATA_INTEGRITY',
    'incident_source', 'TIME_SYNC',
    'severity', p_severity,
    'title', case p_kind
               when 'DRIFT_EXCEEDED' then format('Clock of database node %s is outside the allowed offset from its time reference', p_node)
               when 'REFERENCE_LOST' then format('Database node %s lost every time reference', p_node)
               when 'NO_TIME_SOURCE' then format('No active time source is configured for database node %s', p_node)
               when 'CLOCK_REGRESSION' then format('Clock of database node %s stepped back', p_node)
               else format('Time fault %s on %s', p_kind, p_node) end,
    'alarm_id', v_id,
    'alarm_kind', p_kind,
    'node', p_node,
    'window_start', v_alarm.window_start,
    'raised_at', v_alarm.recorded_at,
    'details', coalesce(p_details, '{}'::jsonb)));
  return v_id;
end
$$;

create function platform.open_alarm_id(p_subject text, p_kind text) returns uuid
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select a.id from platform.alarm a
  where a.subject = p_subject and a.kind = p_kind
    and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id)
  order by a.recorded_at desc
  limit 1
$$;

create function platform.register_time_source(p_name text, p_kind text, p_endpoint text, p_reference text,
                                              p_validated_by uuid, p_validation_ref text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
  v_id  uuid;
begin
  perform platform.authorize('platform.time_source.manage', 'time_source', p_name);
  insert into platform.time_source (name, kind, endpoint, reference, validated_by, validation_ref, registered_by)
  values (p_name, p_kind, p_endpoint, p_reference, p_validated_by, p_validation_ref, v_ctx ->> 'person_id')
  returning id into v_id;
  return v_id;
end
$$;

-- Activating or deactivating a source is a change and needs a reason (audit trail, DI-24).
create function platform.set_time_source_active(p_source_id uuid, p_active boolean) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
begin
  perform platform.require_actor();
  perform platform.authorize('platform.time_source.manage', 'time_source', p_source_id::text);
  update platform.time_source set active = p_active where id = p_source_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-030 unknown time source %s', p_source_id);
  end if;
end
$$;

-- Records one drift check of a database node. p_samples is a JSON array of
--   {"source_id": uuid, "reachable": true, "offset_s": "0.012345", "uncertainty_s": "0.000800"}
--   {"source_id": uuid, "reachable": false, "error": "timeout"}
-- (offsets as decimal strings, positive when the node is ahead of the reference). Every active
-- source gets a sample; an active source without a reading is recorded as unreachable. Returns a
-- summary with the alarms raised and cleared.
create function platform.record_drift_check(p_node text, p_samples jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx        jsonb := platform.require_actor();
  v_check      uuid := gen_random_uuid();
  v_threshold  numeric := platform.setting_numeric('time.drift_alarm_threshold_s');
  v_min_refs   integer := platform.setting_numeric('time.min_references')::integer;
  v_elem       jsonb;
  v_src        platform.time_source%rowtype;
  v_reading    jsonb;
  v_reachable  boolean;
  v_offset     numeric;
  v_active     integer := 0;
  v_ok_refs    integer := 0;
  v_exceeded   integer := 0;
  v_raised     jsonb := '[]'::jsonb;
  v_cleared    jsonb := '[]'::jsonb;
  v_alarm      record;
  v_resolved   boolean;
  v_details    jsonb;
begin
  if p_node is null or p_node !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 invalid node name %s', coalesce(p_node, 'NULL'));
  end if;
  -- Readings raise and clear data-integrity alarms, so only the time monitor (a SYSTEM service
  -- identity holding the permission) may submit them; a person cannot declare the clock healthy.
  if v_ctx ->> 'source' <> 'SYSTEM' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-037 drift readings are recorded only by the time monitor (source SYSTEM)';
  end if;
  perform platform.authorize('platform.time_check.record', 'time_node', p_node);
  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-031 samples must be a JSON array';
  end if;
  for v_elem in select * from jsonb_array_elements(p_samples) loop
    if jsonb_typeof(v_elem) <> 'object' or coalesce(v_elem ->> 'source_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_elem -> 'reachable') is distinct from 'boolean' then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 malformed drift sample %s', v_elem);
    end if;
    if not exists (select 1 from platform.time_source where id = (v_elem ->> 'source_id')::uuid and active) then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-030 %s is not an active time source', v_elem ->> 'source_id');
    end if;
    if (v_elem ->> 'reachable')::boolean and coalesce(v_elem ->> 'offset_s', '') !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 a reachable sample needs offset_s as a decimal string: %s', v_elem);
    end if;
    if coalesce(v_elem ->> 'uncertainty_s', '0') !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 uncertainty_s must be a non-negative decimal string: %s', v_elem);
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_samples) e) <> (select count(distinct e ->> 'source_id') from jsonb_array_elements(p_samples) e) then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-031 more than one sample for the same source in one check';
  end if;

  for v_src in select * from platform.time_source where active order by name loop
    v_active := v_active + 1;
    select e into v_reading from jsonb_array_elements(p_samples) e where (e ->> 'source_id')::uuid = v_src.id;
    v_reachable := coalesce((v_reading ->> 'reachable')::boolean, false);
    v_offset := case when v_reachable then (v_reading ->> 'offset_s')::numeric end;
    insert into platform.drift_sample (check_id, node, source_id, reachable, offset_s, uncertainty_s, threshold_s, within_threshold, error)
    values (v_check, p_node, v_src.id, v_reachable, v_offset, (v_reading ->> 'uncertainty_s')::numeric, v_threshold,
            v_reachable and abs(v_offset) <= v_threshold,
            case when v_reading is null then 'no reading supplied for this active source'
                 when not v_reachable then left(coalesce(v_reading ->> 'error', 'unreachable'), 500) end);
    if v_reachable then
      v_ok_refs := v_ok_refs + 1;
      if abs(v_offset) > v_threshold then v_exceeded := v_exceeded + 1; end if;
    end if;
  end loop;

  v_details := jsonb_build_object('check_id', v_check, 'threshold_s', v_threshold::text, 'active_sources', v_active,
                                  'reachable_sources', v_ok_refs, 'sources_over_threshold', v_exceeded,
                                  'offsets', (select coalesce(jsonb_agg(jsonb_build_object('source', t.name, 'offset_s', d.offset_s::text, 'reachable', d.reachable) order by t.name), '[]'::jsonb)
                                              from platform.drift_sample d join platform.time_source t on t.id = d.source_id where d.check_id = v_check));

  -- Raise (once per open condition).
  if v_active = 0 and platform.open_alarm_id(p_node, 'NO_TIME_SOURCE') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'NO_TIME_SOURCE', 'alarm_id', platform.raise_time_incident('NO_TIME_SOURCE', p_node, 'MAJOR', v_details, v_check));
  end if;
  if v_active > 0 and v_ok_refs = 0 and platform.open_alarm_id(p_node, 'REFERENCE_LOST') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'REFERENCE_LOST', 'alarm_id', platform.raise_time_incident('REFERENCE_LOST', p_node, 'MAJOR', v_details, v_check));
  end if;
  if v_exceeded > 0 and platform.open_alarm_id(p_node, 'DRIFT_EXCEEDED') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'DRIFT_EXCEEDED', 'alarm_id', platform.raise_time_incident('DRIFT_EXCEEDED', p_node, 'MAJOR', v_details, v_check));
  end if;
  if v_ok_refs > 0 and v_ok_refs < v_min_refs and platform.open_alarm_id(p_node, 'REFERENCE_DEGRADED') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'REFERENCE_DEGRADED', 'alarm_id', platform.raise_alarm('REFERENCE_DEGRADED', p_node, 'MINOR', false, v_details, v_check));
  end if;

  -- Clear open alarms whose condition no longer holds.
  for v_alarm in
    select a.id, a.kind from platform.alarm a
    where a.subject = p_node and a.check_id is distinct from v_check
      and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id)
  loop
    v_resolved := case v_alarm.kind
      when 'NO_TIME_SOURCE' then v_active > 0
      when 'REFERENCE_LOST' then v_ok_refs > 0
      when 'DRIFT_EXCEEDED' then v_ok_refs > 0 and v_exceeded = 0
      when 'REFERENCE_DEGRADED' then v_ok_refs >= v_min_refs
      else false end;
    if v_resolved then
      insert into platform.alarm_clearance (alarm_id, subject, check_id, note)
      values (v_alarm.id, p_node, v_check, format('condition resolved: %s of %s sources reachable, %s over the %s s threshold', v_ok_refs, v_active, v_exceeded, v_threshold));
      v_cleared := v_cleared || jsonb_build_object('kind', v_alarm.kind, 'alarm_id', v_alarm.id);
    end if;
  end loop;

  return v_details || jsonb_build_object('raised', v_raised, 'cleared', v_cleared);
end
$$;

-- Manual clearance for an alarm whose condition the monitor does not re-check (e.g. one raised
-- by another component). Needs a reason and the permission platform.alarm.clear.
create function platform.clear_alarm(p_alarm_id uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_alarm platform.alarm%rowtype;
begin
  if coalesce(v_ctx ->> 'reason_code', '') = '' or coalesce(trim(p_note), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-032 clearing an alarm needs a reason and a note';
  end if;
  select * into v_alarm from platform.alarm where id = p_alarm_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-032 unknown alarm %s', p_alarm_id);
  end if;
  perform platform.authorize('platform.alarm.clear', 'time_node', v_alarm.subject);
  insert into platform.alarm_clearance (alarm_id, subject, note) values (p_alarm_id, v_alarm.subject, p_note);
end
$$;

-- Fault windows: from the last good sample before a fault alarm until its clearance (open while
-- the alarm is open).
create function platform.time_fault_windows()
returns table (alarm_id uuid, kind text, node text, window_start timestamptz, window_end timestamptz)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select a.id, a.kind, a.subject, a.window_start, c.recorded_at
  from platform.alarm a left join platform.alarm_clearance c on c.alarm_id = a.id
  where platform.is_time_fault(a.kind)
  order by a.window_start
$$;

create function platform.time_fault_open() returns boolean
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select exists (select 1 from platform.alarm a
                 where platform.is_time_fault(a.kind)
                   and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id))
$$;

-- Every audited GMP entry recorded inside a fault window, for review (DI-27). The monitor's own
-- records are left out.
create function platform.entries_in_time_fault_windows()
returns table (alarm_id uuid, alarm_kind text, node text, chain_key text, seq bigint, action text,
               table_name text, record_id text, recorded_at timestamptz)
language sql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
  select w.alarm_id, w.kind, w.node, e.chain_key, e.seq, e.action, e.table_name, e.record_id, e.recorded_at
  from platform.time_fault_windows() w
  join kernel.audit_event e
    on e.recorded_at >= w.window_start and (w.window_end is null or e.recorded_at <= w.window_end)
  where coalesce(e.table_name, '') not in ('platform.drift_sample', 'platform.alarm', 'platform.alarm_clearance', 'platform.time_source')
    and e.chain_key not like 'time\_node:%'
  order by e.recorded_at, e.chain_key, e.seq
$$;

select platform.enforce_db_time('platform.time_source', array['recorded_at']);
select platform.enforce_db_time('platform.drift_sample', array['recorded_at']);
select platform.enforce_db_time('platform.alarm', array['recorded_at']);
select platform.enforce_db_time('platform.alarm_clearance', array['recorded_at']);
select kernel.register_audited_table('platform.time_source', 'time_source', 'id', false);
select kernel.register_audited_table('platform.drift_sample', 'time_node', 'node', true);
select kernel.register_audited_table('platform.alarm', 'time_node', 'subject', true);
select kernel.register_audited_table('platform.alarm_clearance', 'time_node', 'subject', true);

grant select on platform.time_source, platform.drift_sample, platform.alarm, platform.alarm_clearance to ebmr_app;
grant execute on function platform.register_time_source(text, text, text, text, uuid, text),
                          platform.set_time_source_active(uuid, boolean),
                          platform.record_drift_check(text, jsonb),
                          platform.raise_time_incident(text, text, text, jsonb, uuid), platform.clear_alarm(uuid, text),
                          platform.time_fault_windows(), platform.time_fault_open(),
                          platform.entries_in_time_fault_windows(), platform.is_time_fault(text) to ebmr_app;
-- raise_alarm and time_window_start stay private: alarms without an incident come only from the monitor.

reset role;
