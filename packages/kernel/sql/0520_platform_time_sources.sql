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
-- traceable to NPL India or NIC, recorded with the validation that approved it. No person alone
-- decides which references the drift monitor trusts (DI-27, DI-24):
--   * the registrant (permission platform.time_source.manage, an IT function) records a source
--     and names the person who validated it; the registration is pending
--     (platform.time_source_registration) and the monitor does not use it;
--   * the named validator, another person holding platform.time_source.validate (the CSV / data-
--     integrity function), confirms the validation in their own command; only then does the source
--     exist in platform.time_source, with validated_by taken from that command, never supplied;
--   * deactivating a source so that fewer than time.min_references stay active is the validator's
--     decision too: the registrant's permission alone is not enough.
create table platform.time_source_registration (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique check (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._()/-]{1,99}$'),
  kind              text not null check (kind in ('NTP')),
  endpoint          text not null check (btrim(endpoint) <> ''),
  reference         text not null check (btrim(reference) <> ''),
  validator_person  uuid not null,
  validation_ref    text not null check (btrim(validation_ref) <> ''),
  registered_by     text not null,
  recorded_at       timestamptz not null default clock_timestamp()
);

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

-- One sample per active source and check. Offsets and uncertainties are stored exactly as the
-- monitor measured them (no precision limit: a clock reset to 1970 is an offset of about 1.8e9 s and
-- must alarm, not overflow). The threshold has the three decimals its setting allows. The three
-- verdicts are computed from exactly the stored values, and the check constraints hold them to it:
--   within_threshold  the offset is within the threshold even at the edge of its uncertainty
--                     (|offset| + uncertainty <= threshold): proof that the clock was good;
--   over_threshold    the offset is above the threshold and the reading is conclusive (its
--                     uncertainty is within the threshold, or even |offset| - uncertainty is above it);
--   usable            the reading is conclusive either way. A reading whose uncertainty is above the
--                     threshold and that does not prove an exceedance proves nothing: it neither raises
--                     nor clears an offset alarm and counts as an unusable reference.
-- audit_position is platform.audit_position() when the sample was recorded (review windows, below).
create table platform.drift_sample (
  id             bigint generated always as identity primary key,
  check_id       uuid not null,
  node           text not null,
  source_id      uuid not null references platform.time_source (id),
  reachable      boolean not null,
  offset_s       numeric,
  uncertainty_s  numeric check (uncertainty_s is null or uncertainty_s >= 0),
  threshold_s    numeric(6, 3) not null,
  within_threshold boolean not null,
  over_threshold boolean not null,
  usable         boolean not null,
  error          text,
  audit_position bigint not null,
  recorded_at    timestamptz not null default clock_timestamp(),
  check (reachable = (offset_s is not null)),
  check (not reachable or uncertainty_s is not null),
  check (within_threshold = coalesce(reachable and abs(offset_s) + uncertainty_s <= threshold_s, false)),
  check (usable = coalesce(reachable and (uncertainty_s <= threshold_s or abs(offset_s) - uncertainty_s > threshold_s), false)),
  check (over_threshold = coalesce(usable and abs(offset_s) > threshold_s, false))
);
create index drift_sample_node on platform.drift_sample (node, id);

-- An alarm's review window runs from the node's last good sample to the alarm's clearance. It is
-- bounded by audit positions as well as times: window_start_position is the audit position of the
-- last good sample, the clearance's window_end_position the audit position when it was recorded.
create table platform.alarm (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('DRIFT_EXCEEDED', 'REFERENCE_LOST', 'REFERENCE_DEGRADED', 'NO_TIME_SOURCE', 'CLOCK_REGRESSION')),
  subject             text not null,
  severity            text not null check (severity in ('MINOR', 'MAJOR', 'CRITICAL')),
  incident_requested  boolean not null,
  window_start        timestamptz not null,
  window_start_position bigint not null,
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
  window_end_position bigint not null,
  recorded_at  timestamptz not null default clock_timestamp()
);

-- Alarm kinds during which recorded times cannot be trusted.
create function platform.is_time_fault(p_kind text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_kind in ('DRIFT_EXCEEDED', 'REFERENCE_LOST', 'NO_TIME_SOURCE')
$$;

-- Alarm kinds whose condition the drift monitor evaluates on every check: only
-- platform.record_drift_check raises and clears them, from the readings it records.
create function platform.is_monitored_condition(p_kind text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_kind in ('DRIFT_EXCEEDED', 'REFERENCE_LOST', 'NO_TIME_SOURCE', 'REFERENCE_DEGRADED')
$$;

-- Position in the audit trail: the highest kernel.audit_event id handed out so far by any session
-- (sequence values are not transactional). Positions order entries by when they were recorded,
-- whatever the database clock said, so a review window bounded by positions still holds every entry
-- made while the clock was wrong, even when the fault came or went with a clock step (DI-27).
create function platform.audit_position() returns bigint
language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(pg_sequence_last_value(pg_get_serial_sequence('kernel.audit_event', 'id')::regclass), 0)
$$;

-- Start of the window of doubt for a node: the last sample within threshold (the latest in the
-- order samples were recorded, not by their clock time), else the node's first sample, else now.
create function platform.time_window_start(p_node text, p_exclude_check uuid default null,
                                           out window_start timestamptz, out window_start_position bigint)
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  select d.recorded_at, d.audit_position into window_start, window_start_position
  from platform.drift_sample d
  where d.node = p_node and d.within_threshold and d.check_id is distinct from p_exclude_check
  order by d.id desc limit 1;
  if not found then
    select d.recorded_at, d.audit_position into window_start, window_start_position
    from platform.drift_sample d where d.node = p_node order by d.id limit 1;
  end if;
  if window_start is null then
    window_start := clock_timestamp();
    window_start_position := platform.audit_position();
  end if;
end
$$;

create function platform.raise_alarm(p_kind text, p_subject text, p_severity text, p_incident boolean,
                                     p_details jsonb, p_check_id uuid default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_start record;
  v_id    uuid;
begin
  if coalesce(trim(p_subject), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-031 an alarm needs a subject (e.g. the database node)';
  end if;
  select * into v_start from platform.time_window_start(p_subject, p_check_id);
  insert into platform.alarm (kind, subject, severity, incident_requested, window_start, window_start_position, check_id, details, raised_by_person)
  values (p_kind, p_subject, p_severity, p_incident, v_start.window_start, v_start.window_start_position, p_check_id,
          coalesce(p_details, '{}'::jsonb), v_ctx ->> 'person_id')
  returning id into v_id;
  return v_id;
end
$$;

-- Hook to the data-integrity incident register (records module). For now it records the alarm
-- and emits outbox message incident.requested; kernel 0900 replaces it to raise the incident in
-- the same transaction. Owner only: the drift monitor (platform.record_drift_check) and
-- platform.report_time_fault call it; the application cannot raise a time fault directly.
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

-- A time fault the drift monitor does not evaluate itself (today CLOCK_REGRESSION, e.g. a failover
-- check that sees the clock step back), reported by a time service: source SYSTEM and the
-- permission platform.time_check.record, like the monitor's readings. The conditions the monitor
-- evaluates (offset, lost or degraded references, no source) are raised only from recorded readings,
-- so nobody can raise them early and keep the monitor from raising its own alarm and incident.
create function platform.report_time_fault(p_kind text, p_node text, p_severity text, p_details jsonb default '{}'::jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
begin
  if coalesce(v_ctx ->> 'source', '') <> 'SYSTEM' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-037 time faults are reported only by a time service (source SYSTEM)';
  end if;
  if p_node is null or p_node !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 invalid node name %s', coalesce(p_node, 'NULL'));
  end if;
  perform platform.authorize('platform.time_check.record', 'time_node', p_node);
  if p_kind is null or platform.is_monitored_condition(p_kind) or p_kind not in ('CLOCK_REGRESSION') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-036 %s cannot be reported: offset and reference alarms come only from the drift monitor''s recorded readings', coalesce(p_kind, 'NULL'));
  end if;
  if p_severity is null or p_severity not in ('MINOR', 'MAJOR', 'CRITICAL') then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-036 unknown severity %s', coalesce(p_severity, 'NULL'));
  end if;
  if platform.open_alarm_id(p_node, p_kind) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-036 a %s alarm is already open for %s', p_kind, p_node);
  end if;
  return platform.raise_time_incident(p_kind, p_node, p_severity, p_details, null);
end
$$;

-- Registers a time source, pending the validation confirmation of p_validated_by (a person other
-- than the registrant). Returns the id the source will have once confirmed.
create function platform.register_time_source(p_name text, p_kind text, p_endpoint text, p_reference text,
                                              p_validated_by uuid, p_validation_ref text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
  v_id  uuid;
begin
  perform platform.authorize('platform.time_source.manage', 'time_source', p_name);
  if p_validated_by is null
     or not exists (select 1 from iam.person p where p.id = p_validated_by and p.kind = 'NATURAL' and p.status = 'ACTIVE') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-033 validated_by %s is not an active person: a time source is registered with the person who validated it',
                       coalesce(p_validated_by::text, 'NULL'));
  end if;
  if p_validated_by::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-033 the registrant cannot be the validator of the time source they register';
  end if;
  if exists (select 1 from platform.time_source where name = p_name) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-033 a time source named %s already exists', p_name);
  end if;
  insert into platform.time_source_registration (name, kind, endpoint, reference, validator_person, validation_ref, registered_by)
  values (p_name, p_kind, p_endpoint, p_reference, p_validated_by, p_validation_ref, v_ctx ->> 'person_id')
  returning id into v_id;
  return v_id;
end
$$;

-- The named validator confirms a pending registration; the source becomes an active, validated
-- source of the drift monitor. Returns its id (the registration id).
create function platform.confirm_time_source(p_registration_id uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
  r     platform.time_source_registration%rowtype;
begin
  select * into r from platform.time_source_registration where id = p_registration_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-030 unknown time source registration %s', p_registration_id);
  end if;
  perform platform.authorize('platform.time_source.validate', 'time_source', r.name);
  if (v_ctx ->> 'person_id') is distinct from r.validator_person::text then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-034 only %s, named as the validator of time source %s, can confirm its validation', r.validator_person, r.name);
  end if;
  if (v_ctx ->> 'person_id') = r.registered_by then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-034 the registrant cannot confirm the validation of the time source they registered';
  end if;
  if exists (select 1 from platform.time_source where id = r.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-034 time source %s is already confirmed', r.name);
  end if;
  insert into platform.time_source (id, name, kind, endpoint, reference, validated_by, validation_ref, active, registered_by)
  values (r.id, r.name, r.kind, r.endpoint, r.reference, (v_ctx ->> 'person_id')::uuid, r.validation_ref, true, r.registered_by);
  return r.id;
end
$$;

-- Activating or deactivating a source is a change and needs a reason (audit trail, DI-24). A
-- deactivation that leaves fewer active sources than time.min_references needs the validator's
-- permission platform.time_source.validate instead of the registrant's.
create function platform.set_time_source_active(p_source_id uuid, p_active boolean) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_src       platform.time_source%rowtype;
  v_remaining integer;
  v_min       integer := platform.setting_numeric('time.min_references')::integer;
  v_problem   text;
begin
  perform platform.require_actor();
  -- Deactivations are serialised, so two of them cannot each leave the minimum.
  perform 1 from platform.time_source where active order by id for update;
  select * into v_src from platform.time_source where id = p_source_id for update;
  if not found then
    perform platform.authorize('platform.time_source.manage', 'time_source', p_source_id::text);
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-030 unknown time source %s', p_source_id);
  end if;
  v_remaining := (select count(*) from platform.time_source where active and id <> p_source_id);
  if v_src.active and not coalesce(p_active, true) and v_remaining < v_min then
    v_problem := platform.permission_problem('platform.time_source.validate', 'time_source', p_source_id::text);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-035 deactivating %s would leave %s active time source(s), fewer than time.min_references (%s); '
                         'that is the validator''s decision (platform.time_source.validate): %s', v_src.name, v_remaining, v_min, v_problem);
    end if;
  else
    perform platform.authorize('platform.time_source.manage', 'time_source', p_source_id::text);
  end if;
  update platform.time_source set active = p_active where id = p_source_id;
end
$$;

-- Records one drift check of a database node. p_samples is a JSON array of
--   {"source_id": uuid, "reachable": true, "offset_s": "0.012345", "uncertainty_s": "0.000800"}
--   {"source_id": uuid, "reachable": false, "error": "timeout"}
-- (offsets and uncertainties as decimal strings, positive offset when the node is ahead of the
-- reference). Every active source gets a sample; an active source without a reading is recorded as
-- unreachable. Returns a summary with the alarms raised and cleared. Conditions (from the stored
-- verdicts of this check's samples, see platform.drift_sample):
--   DRIFT_EXCEEDED      raised when a usable reading is over the threshold; cleared only when every
--                       usable reading proves the clock within it (and there is at least one);
--   REFERENCE_LOST      no usable reading (unreachable, or too uncertain to decide anything);
--   REFERENCE_DEGRADED  fewer usable readings than time.min_references;
--   NO_TIME_SOURCE      no active source.
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
  v_unc        numeric;
  v_active     integer;
  v_reached    integer;
  v_usable     integer;
  v_within     integer;
  v_exceeded   integer;
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
  if coalesce(v_ctx ->> 'source', '') <> 'SYSTEM' then
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
    if (v_elem ->> 'reachable')::boolean and coalesce(v_elem ->> 'offset_s', '') !~ '^-?[0-9]{1,40}(\.[0-9]{1,40})?$' then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 a reachable sample needs offset_s as a decimal string: %s', v_elem);
    end if;
    if (v_elem ->> 'reachable')::boolean and not (v_elem ? 'uncertainty_s') then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 a reachable sample needs uncertainty_s: %s', v_elem);
    end if;
    if coalesce(v_elem ->> 'uncertainty_s', '0') !~ '^[0-9]{1,40}(\.[0-9]{1,40})?$' then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-031 uncertainty_s must be a non-negative decimal string: %s', v_elem);
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_samples) e) <> (select count(distinct e ->> 'source_id') from jsonb_array_elements(p_samples) e) then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-031 more than one sample for the same source in one check';
  end if;

  for v_src in select * from platform.time_source where active order by name loop
    select e into v_reading from jsonb_array_elements(p_samples) e where (e ->> 'source_id')::uuid = v_src.id;
    v_reachable := coalesce((v_reading ->> 'reachable')::boolean, false);
    v_offset := case when v_reachable then (v_reading ->> 'offset_s')::numeric end;
    v_unc := case when v_reachable then (v_reading ->> 'uncertainty_s')::numeric end;
    -- The verdicts are computed from the values as stored (the same expressions as the table's checks).
    insert into platform.drift_sample (check_id, node, source_id, reachable, offset_s, uncertainty_s, threshold_s,
                                       within_threshold, over_threshold, usable, error, audit_position)
    select v_check, p_node, v_src.id, v_reachable, x.off, x.unc, x.thr,
           coalesce(v_reachable and abs(x.off) + x.unc <= x.thr, false),
           coalesce(v_reachable and (x.unc <= x.thr or abs(x.off) - x.unc > x.thr) and abs(x.off) > x.thr, false),
           coalesce(v_reachable and (x.unc <= x.thr or abs(x.off) - x.unc > x.thr), false),
           case when v_reading is null then 'no reading supplied for this active source'
                when not v_reachable then left(coalesce(v_reading ->> 'error', 'unreachable'), 500) end,
           platform.audit_position()
    from (select v_offset as off, v_unc as unc, v_threshold::numeric(6, 3) as thr) x;
  end loop;

  select count(*), count(*) filter (where reachable), count(*) filter (where usable),
         count(*) filter (where within_threshold), count(*) filter (where over_threshold)
    into v_active, v_reached, v_usable, v_within, v_exceeded
  from platform.drift_sample where check_id = v_check;

  v_details := jsonb_build_object('check_id', v_check, 'threshold_s', v_threshold::text, 'active_sources', v_active,
                                  'reachable_sources', v_reached, 'usable_sources', v_usable, 'sources_within_threshold', v_within,
                                  'sources_over_threshold', v_exceeded,
                                  'offsets', (select coalesce(jsonb_agg(jsonb_build_object('source', t.name, 'offset_s', d.offset_s::text,
                                                                                           'uncertainty_s', d.uncertainty_s::text, 'reachable', d.reachable,
                                                                                           'usable', d.usable, 'within_threshold', d.within_threshold,
                                                                                           'over_threshold', d.over_threshold) order by t.name), '[]'::jsonb)
                                              from platform.drift_sample d join platform.time_source t on t.id = d.source_id where d.check_id = v_check));

  -- Raise (once per open condition; only this function raises these kinds, see report_time_fault).
  if v_active = 0 and platform.open_alarm_id(p_node, 'NO_TIME_SOURCE') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'NO_TIME_SOURCE', 'alarm_id', platform.raise_time_incident('NO_TIME_SOURCE', p_node, 'MAJOR', v_details, v_check));
  end if;
  if v_active > 0 and v_usable = 0 and platform.open_alarm_id(p_node, 'REFERENCE_LOST') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'REFERENCE_LOST', 'alarm_id', platform.raise_time_incident('REFERENCE_LOST', p_node, 'MAJOR', v_details, v_check));
  end if;
  if v_exceeded > 0 and platform.open_alarm_id(p_node, 'DRIFT_EXCEEDED') is null then
    v_raised := v_raised || jsonb_build_object('kind', 'DRIFT_EXCEEDED', 'alarm_id', platform.raise_time_incident('DRIFT_EXCEEDED', p_node, 'MAJOR', v_details, v_check));
  end if;
  if v_usable > 0 and v_usable < v_min_refs and platform.open_alarm_id(p_node, 'REFERENCE_DEGRADED') is null then
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
      when 'REFERENCE_LOST' then v_usable > 0
      when 'DRIFT_EXCEEDED' then v_usable > 0 and v_exceeded = 0 and v_within = v_usable
      when 'REFERENCE_DEGRADED' then v_usable >= v_min_refs
      else false end;
    if v_resolved then
      insert into platform.alarm_clearance (alarm_id, subject, check_id, note, window_end_position)
      values (v_alarm.id, p_node, v_check,
              format('condition resolved: %s of %s sources usable, %s within and %s over the %s s threshold', v_usable, v_active, v_within, v_exceeded, v_threshold),
              platform.audit_position());
      v_cleared := v_cleared || jsonb_build_object('kind', v_alarm.kind, 'alarm_id', v_alarm.id);
    end if;
  end loop;

  return v_details || jsonb_build_object('raised', v_raised, 'cleared', v_cleared);
end
$$;

-- Manual clearance for an alarm whose condition the monitor does not re-check (e.g. one reported
-- by another component). Needs a reason and the permission platform.alarm.clear.
create function platform.clear_alarm(p_alarm_id uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_alarm platform.alarm%rowtype;
begin
  if kernel.is_blank(v_ctx ->> 'reason_code') or kernel.is_blank(p_note) then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-032 clearing an alarm needs a reason and a note';
  end if;
  select * into v_alarm from platform.alarm where id = p_alarm_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-032 unknown alarm %s', p_alarm_id);
  end if;
  perform platform.authorize('platform.alarm.clear', 'time_node', v_alarm.subject);
  insert into platform.alarm_clearance (alarm_id, subject, note, window_end_position)
  values (p_alarm_id, v_alarm.subject, p_note, platform.audit_position());
end
$$;

-- Fault windows: from the last good sample before a fault alarm until its clearance (open while
-- the alarm is open). The times are what the node's clock said; the positions bound the window.
create function platform.time_fault_windows()
returns table (alarm_id uuid, kind text, node text, window_start timestamptz, window_end timestamptz,
               window_start_position bigint, window_end_position bigint)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select a.id, a.kind, a.subject, a.window_start, c.recorded_at, a.window_start_position, c.window_end_position
  from platform.alarm a left join platform.alarm_clearance c on c.alarm_id = a.id
  where platform.is_time_fault(a.kind)
  order by a.window_start_position, a.id
$$;

create function platform.time_fault_open() returns boolean
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select exists (select 1 from platform.alarm a
                 where platform.is_time_fault(a.kind)
                   and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id))
$$;

-- Every audited GMP entry recorded inside a fault window, for review (DI-27). An entry belongs to
-- the window by its audit position (after the last good sample, up to the clearance), never by the
-- time the faulty clock stamped on it: entries recorded across a clock step are listed too. The
-- monitor's own records are left out.
create function platform.entries_in_time_fault_windows()
returns table (alarm_id uuid, alarm_kind text, node text, chain_key text, seq bigint, action text,
               table_name text, record_id text, recorded_at timestamptz)
language sql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
  select w.alarm_id, w.kind, w.node, e.chain_key, e.seq, e.action, e.table_name, e.record_id, e.recorded_at
  from platform.time_fault_windows() w
  join kernel.audit_event e
    on e.id > w.window_start_position and (w.window_end_position is null or e.id <= w.window_end_position)
  where coalesce(e.table_name, '') not in ('platform.drift_sample', 'platform.alarm', 'platform.alarm_clearance', 'platform.time_source',
                                           'platform.time_source_registration')
    and e.chain_key not like 'time\_node:%'
  order by e.id
$$;

-- Health query (must return no rows): database nodes whose newest drift check is older than
-- time.drift_check_max_age_s. A monitor that stops recording (it cannot reach the database, or
-- every check it submits is refused) is thereby detected by the scheduled invariant run.
create function platform.time_monitor_violations()
returns table (node text, last_check_at timestamptz, problem text)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select d.node, max(d.recorded_at),
         format('no drift check recorded since %s (more than time.drift_check_max_age_s = %s s): the time monitor is not recording',
                max(d.recorded_at), platform.setting_text('time.drift_check_max_age_s'))
  from platform.drift_sample d
  group by d.node
  having max(d.recorded_at) < clock_timestamp() - make_interval(secs => platform.setting_numeric('time.drift_check_max_age_s')::integer)
  order by d.node
$$;

select platform.enforce_db_time('platform.time_source_registration', array['recorded_at']);
select platform.enforce_db_time('platform.time_source', array['recorded_at']);
select platform.enforce_db_time('platform.drift_sample', array['recorded_at']);
select platform.enforce_db_time('platform.alarm', array['recorded_at']);
select platform.enforce_db_time('platform.alarm_clearance', array['recorded_at']);
select kernel.register_audited_table('platform.time_source_registration', 'time_source', 'id', true);
select kernel.register_audited_table('platform.time_source', 'time_source', 'id', false);
select kernel.register_audited_table('platform.drift_sample', 'time_node', 'node', true);
select kernel.register_audited_table('platform.alarm', 'time_node', 'subject', true);
select kernel.register_audited_table('platform.alarm_clearance', 'time_node', 'subject', true);

grant select on platform.time_source_registration, platform.time_source, platform.drift_sample, platform.alarm,
                platform.alarm_clearance to ebmr_app;
grant execute on function platform.register_time_source(text, text, text, text, uuid, text),
                          platform.confirm_time_source(uuid),
                          platform.set_time_source_active(uuid, boolean),
                          platform.record_drift_check(text, jsonb),
                          platform.report_time_fault(text, text, text, jsonb), platform.clear_alarm(uuid, text),
                          platform.time_fault_windows(), platform.time_fault_open(),
                          platform.entries_in_time_fault_windows(), platform.time_monitor_violations(),
                          platform.is_time_fault(text), platform.is_monitored_condition(text),
                          platform.audit_position() to ebmr_app;
-- raise_alarm, raise_time_incident and time_window_start stay private: time alarms come only from the
-- monitor's recorded readings (record_drift_check) and from report_time_fault, never directly.

reset role;
