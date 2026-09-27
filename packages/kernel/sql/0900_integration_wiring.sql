-- Integration wiring between kernel modules (Phase 1). Each module was built on its own; this file
-- connects them where one module's event must reach another in the same transaction. It runs after
-- every module migration (0100-0699).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. Identifiers that appear outside the database must never be reissued after a restore (INV-27).
--    Kernel modules numbered below 0600 could not register themselves with continuity.
-- ---------------------------------------------------------------------------------------------

select continuity.register_protected_sequence('records.incident.incident_no',
  pg_get_serial_sequence('records.incident', 'incident_no')::regclass,
  'OTHER', 'records', 'Incident numbers (quoted in CAPA, CERT-In reports and batch dossiers)', 100000);
select continuity.register_protected_sequence('records.di_investigation.investigation_no',
  pg_get_serial_sequence('records.di_investigation', 'investigation_no')::regclass,
  'OTHER', 'records', 'Data-integrity investigation numbers (quoted in reports and CAPA)', 100000);
select continuity.register_protected_sequence('platform.outbox.id',
  pg_get_serial_sequence('platform.outbox', 'id')::regclass,
  'OTHER', 'platform', 'Outbox message ids (consumers de-duplicate on them)', 10000000);
select continuity.register_protected_sequence('platform.state_history.id',
  pg_get_serial_sequence('platform.state_history', 'id')::regclass,
  'OTHER', 'platform', 'State-history ids (returned to callers and quoted in reviews)', 10000000);

-- ---------------------------------------------------------------------------------------------
-- 2. Shared and Grade A/B terminals: no session without a current hardening attestation
--    (DI-13: USB mass storage blocked, kiosk mode). Checked when a session opens, so a lapsed or
--    revoked attestation stops new sessions at once.
-- ---------------------------------------------------------------------------------------------

create function iam.session_requires_hardened_device() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, continuity, pg_temp as $$
begin
  if new.device_class in ('SHARED', 'GRADE_A_B') then
    perform continuity.assert_device_hardened(new.device_id, new.device_class);
  end if;
  return new;
end
$$;

create trigger ab_session_requires_hardened_device
  before insert on iam.session
  for each row execute function iam.session_requires_hardened_device();

-- ---------------------------------------------------------------------------------------------
-- 3. A time fault raises a data-integrity incident in the same transaction as its alarm (DI-27).
--    Same behaviour as platform 0520 plus the incident; the outbox message now carries its id.
-- ---------------------------------------------------------------------------------------------

create or replace function platform.raise_time_incident(p_kind text, p_node text, p_severity text, p_details jsonb default '{}'::jsonb,
                                                        p_check_id uuid default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_alarm    platform.alarm%rowtype;
  v_id       uuid;
  v_title    text;
  v_incident uuid;
begin
  v_id := platform.raise_alarm(p_kind, p_node, p_severity, true, p_details, p_check_id);
  select * into v_alarm from platform.alarm where id = v_id;
  v_title := case p_kind
               when 'DRIFT_EXCEEDED' then format('Clock of database node %s is outside the allowed offset from its time reference', p_node)
               when 'REFERENCE_LOST' then format('Database node %s lost every time reference', p_node)
               when 'NO_TIME_SOURCE' then format('No active time source is configured for database node %s', p_node)
               when 'CLOCK_REGRESSION' then format('Clock of database node %s stepped back', p_node)
               else format('Time fault %s on %s', p_kind, p_node) end;
  v_incident := records.raise_incident(
    'TIME_SYNC', 'DATA_INTEGRITY', p_severity, v_title,
    format('Raised by the time monitor with alarm %s (%s). Entries recorded from %s may carry an unreliable time and are flagged.',
           v_id, p_kind, v_alarm.window_start),
    jsonb_build_array(jsonb_build_object('aggregateType', 'platform_alarm', 'aggregateId', v_id::text)));
  perform platform.enqueue_message('incident.requested', 'time_node:' || p_node, jsonb_build_object(
    'incident_type', 'DATA_INTEGRITY',
    'incident_source', 'TIME_SYNC',
    'incident_id', v_incident,
    'severity', p_severity,
    'title', v_title,
    'alarm_id', v_id,
    'alarm_kind', p_kind,
    'node', p_node,
    'window_start', v_alarm.window_start,
    'raised_at', v_alarm.recorded_at,
    'details', coalesce(p_details, '{}'::jsonb)));
  return v_id;
end
$$;

reset role;
