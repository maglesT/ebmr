-- Tablets server, module C5: a scale is ONLINE only while a capture on it can reach the server, a reading's age is
-- bounded by its signed capture time when the gateway's clock is synchronised, and a refused claim is alerted in a
-- command of its own, attributed from the validated actor (review findings P51, P53 and P49, round-1 verification;
-- controls DI-20, DI-28, DI-30, DI-31, DI-32, PR-20).
--
-- P51. tab.scale_status said ONLINE from the gateway's heartbeat alone. When the server could not reach the gateway's
-- API (wrong address, blocked port, no API token), or when the server refused a reading of the gateway's chain (every
-- later reading then queues behind it), the heartbeat still said ONLINE: the capture was refused ("scale offline") and
-- so was the manual two-person path (EBMR-EXE-074, "the scale is online"), and the weighing could not be recorded.
-- Now:
--   * tab.gateway_api_contact keeps, per enrolled gateway key, whether the server last reached the gateway's API
--     (operational state, not GMP data). The server records it through tab.record_gateway_api_contact when a capture
--     cannot reach the API, when a capture is answered, and when a probe of the API is answered or not; the first
--     failure raises the alarm EBMR-DEV-071, the recovery EBMR-DEV-072 (the log of when the scales were unusable).
--   * tab.scale_status reports a scale OFFLINE, with the reason, while its gateway's API is not reachable, or while
--     the server has refused a reading of the gateway key's chain (READING_REFUSED, from any session of that key) and
--     has ingested none since. A new enrolment (key) starts clean.
--   * Both conditions end with a write that turns the gateway's scales ONLINE again: the API recorded reachable, or a
--     reading of the chain ingested after the refusal. Like a heartbeat (0310), such a write first takes the room
--     locks of every room of the gateway's instruments (tab.lock_gateway_rooms), so it waits for a hand-keyed weighing
--     of those rooms being recorded, and a weighing checked meanwhile is refused (EBMR-EXE-074, "reporting its
--     status"): no scale turns ONLINE between a weighing's check and its commit.
--   * The application role can record either observation of the API, as it can withhold the heartbeats it relays:
--     showing a scale OFFLINE only opens the manual two-person path, with its second-person check and exception, and
--     recording the API reachable when it is not only returns the scale to what its heartbeat says.
--   * tab.record_heartbeat (0310's, with the room locks) stores the reason a gateway gives for a connected instrument
--     it cannot capture from and deliver (notReady; a state ONLINE with a reason counts as OFFLINE) and alarms the
--     start of each such episode (EBMR-DEV-073), so the server holds a record of why. Its reconciliation by counts
--     (DI-31, EBMR-DEV-070) also takes what the gateway has delivered (deliveredSeq) when that is above its written
--     watermark (ackedSeq), which stays behind while the watermark cannot be written. Its answer tells the server to
--     probe the gateway's API while that is marked unreachable (probeApi; the server keeps it from the gateway), so
--     a recovered API is noticed without a capture, which is refused while the scale is OFFLINE.
--
-- P53. The age of a reading at claim time counts the gateway's reported wait and the database's wait inside the
-- ingesting transaction (0270). The wait before that transaction began is the application's word, so a holder of the
-- application role's credentials could hold back a signed reading and report no wait. For a reading whose trust is
-- DEVICE_SYNCED, its capture time (source_time_us) is signed by the gateway, so the database now also refuses it
-- (EBMR-DEV-104) when the database time minus that capture time exceeds the maximum age plus a clock tolerance. The
-- stated tolerance is twice the site's drift alarm threshold (platform setting time.drift_alarm_threshold_s, default
-- 1 s, so 2 s; the setting allows 0.1 to 5 s): the database clock and the gateway's synchronised clock may each be off
-- the common time reference by up to that threshold before an alarm is due. A DEVICE_UNSYNCED reading carries no capture time the database can
-- trust, so for it the residual stated in 0270 remains; closing it needs a database-issued challenge that the gateway
-- signs together with its wait.
-- Also: tab.ingest_reading refused an absurd reported wait only with PostgreSQL's raw "bigint out of range"; a wait
-- above 100 years (3 155 760 000 000 000 microseconds) is now refused as EBMR-DEV-052 (no gateway measures a longer
-- wait, and the sum with the database's own wait then stays far inside bigint).
--
-- P49. After a claim refused for the room (EBMR-DEV-103) rolls back, the server alerted through the 0250 function
-- tab.alert_claim_refusal(ids, room, code), which compared the balance's room with the room the caller named. A claim
-- that named the balance's own room from a session in another room was refused but never alerted, and the application
-- role could call the function at will, with no session behind it (alert flooding). Now the server runs, after the
-- rollback, a new guarded command under the same actor, and tab.alert_refused_claim takes the session, the person
-- and the session's room from that validated actor (never from the caller): it raises DEVICE_LOCATION_MISMATCH (or
-- BLOCKED_DEVICE_USE for a device that is not ACTIVE) when the balance is not an instrument of the session's room, or
-- when the claim named another room than the session's. The actor must be a person entitled to use readings where
-- they are (as for the claim itself), and each reading is alerted at most once per session. The application role no
-- longer executes the 0250 function.
--
-- Privileges: every function is SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016); CREATE OR REPLACE keeps
-- the owner and grants of the replaced functions. ebmr_app gains EXECUTE on tab.record_gateway_api_contact and
-- tab.alert_refused_claim only, and loses it on tab.alert_claim_refusal. The helpers are not granted.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- P51. Whether the server reaches the gateway's API
-- ---------------------------------------------------------------------------------------------

create table tab.gateway_api_contact (
  gateway_key_id  uuid primary key references tab.gateway_key (id),
  reachable       boolean not null,
  detail          text not null check (btrim(detail) <> '' and length(detail) <= 500),
  -- The last observation, and when the state last changed (reachable to not, or back).
  observed_at     timestamptz not null default clock_timestamp(),
  changed_at      timestamptz not null default clock_timestamp()
);
revoke all on tab.gateway_api_contact from public;

-- What the server observed calling the API of the gateway p_gateway_code (its ACTIVE key): reached or not. A failure
-- after a success (or first of all) raises EBMR-DEV-071, a success after a failure EBMR-DEV-072; a success while the
-- API counts as reachable writes nothing. True when the state was written.
create function tab.record_gateway_api_contact(p_gateway_code text, p_reachable boolean, p_detail text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_key    tab.gateway_key%rowtype;
  v_prev   tab.gateway_api_contact%rowtype;
  v_detail text;
begin
  if p_reachable is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-074 a contact with the gateway API was either reached or not';
  end if;
  select * into v_key from tab.gateway_key where gateway_code = p_gateway_code and status = 'ACTIVE';
  if not found then
    return false;
  end if;
  v_detail := left(coalesce(nullif(btrim(p_detail), ''),
                            case when p_reachable then 'the gateway API answered' else 'the gateway API did not answer' end), 500);
  select * into v_prev from tab.gateway_api_contact where gateway_key_id = v_key.id for update;
  if p_reachable and (v_prev.gateway_key_id is null or v_prev.reachable) then
    return false;
  end if;
  -- PR-20, DI-30: reachable again turns the gateway's scales ONLINE; serialised with hand-keyed weighings (0310).
  if p_reachable then
    perform tab.lock_gateway_rooms(v_key.id);
  end if;
  insert into tab.gateway_api_contact (gateway_key_id, reachable, detail, observed_at, changed_at)
  values (v_key.id, p_reachable, v_detail, clock_timestamp(), clock_timestamp())
  on conflict (gateway_key_id) do update
    set reachable = excluded.reachable, detail = excluded.detail, observed_at = excluded.observed_at,
        changed_at = case when tab.gateway_api_contact.reachable = excluded.reachable then tab.gateway_api_contact.changed_at
                          else excluded.changed_at end;
  if not p_reachable and (v_prev.gateway_key_id is null or v_prev.reachable) then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-071', v_key.gateway_code, null, null, null,
      format('DI-30: the server cannot reach the API of gateway %s (%s); its instruments are shown OFFLINE, so weights may be keyed by hand with a second person''s check, until the server reaches it again',
             v_key.gateway_code, v_detail),
      jsonb_build_object('detail', v_detail));
  elsif p_reachable then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-072', v_key.gateway_code, null, null, null,
      format('DI-30: the server reaches the API of gateway %s again (%s); its instruments follow its heartbeats again', v_key.gateway_code, v_detail),
      jsonb_build_object('detail', v_detail, 'unreachable_since', v_prev.changed_at));
  end if;
  return true;
end
$$;

-- The reason a gateway gives for a connected instrument it cannot capture from and deliver (heartbeat notReady).
alter table tab.instrument_heartbeat add column not_ready text check (not_ready is null or (btrim(not_ready) <> '' and length(not_ready) <= 500));

-- The refusals and claim alarms the checks below look up.
create index device_alarm_reading_refused on tab.device_alarm (session_id, raised_at) where kind = 'READING_REFUSED';
create index device_alarm_claim_refused on tab.device_alarm (session_id, reading_id) where kind = 'CLAIM_REFUSED';

-- Before a write that may turn the scales of gateway key p_key ONLINE: the room locks of 0310 (exclusive, in room
-- order, held to the commit) for every room of an instrument bound to the key, as tab.record_heartbeat takes them for
-- the instruments it reports on. The write waits for a hand-keyed weighing of those rooms being recorded, and is never
-- interleaved with its check (tab.manual_weighing_check takes the same locks in shared mode, without waiting).
create function tab.lock_gateway_rooms(p_key uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_room text;
begin
  for v_room in
    select distinct d.room_code
      from tab.gateway_instrument b join iam.device d on d.id = b.instrument_device_id
     where b.gateway_key_id = p_key and b.ended_at is null and d.room_code is not null
     order by d.room_code
  loop
    perform pg_advisory_xact_lock(hashtextextended('tab.scale_room:' || v_room, 0));
  end loop;
end
$$;

-- True while the server has refused a reading of the chain of gateway key p_key and ingested none since (the hold of
-- tab.scale_offline_reason).
create function tab.chain_refusal_pending(p_key uuid) returns boolean
language sql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
  select exists (
    select 1 from tab.device_alarm a
     where a.kind = 'READING_REFUSED'
       and a.session_id in (select s.session_id from tab.gateway_session s where s.gateway_key_id = p_key)
       and a.raised_at > coalesce((select r.recorded_at from tab.device_reading r where r.chain_id = p_key order by r.seq desc limit 1),
                                  '-infinity'::timestamptz))
$$;

-- Why the scale bound by p_bind (instrument p_device, gateway key p_key, last heartbeat h of that key, or null) cannot
-- be captured from now; null when it can. In order: no heartbeat, not ACTIVE in the registry, heartbeat older than
-- 10 s, another serial, not connected or not ready at the gateway, the gateway's API not reachable from the server, a
-- reading of the key's chain refused by the server with none ingested since.
create function tab.scale_offline_reason(p_key tab.gateway_key, p_bind tab.gateway_instrument, p_device iam.device, h tab.instrument_heartbeat)
returns text
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_contact tab.gateway_api_contact%rowtype;
  v_code    text;
begin
  if h.instrument_device_id is null then
    return 'the site gateway has not reported it yet';
  end if;
  if p_device.status <> 'ACTIVE' then
    return format('%s is %s in the device registry', p_device.code, p_device.status);
  end if;
  if clock_timestamp() - h.reported_at > interval '10 seconds' then
    return 'no heartbeat from the site gateway in the last 10 seconds';
  end if;
  if h.state = 'SERIAL_MISMATCH' or (h.state = 'ONLINE' and h.serial is distinct from p_bind.expected_serial) then
    return format('it answers with serial %s, not the registered %s', coalesce(h.serial, '(none)'), p_bind.expected_serial);
  end if;
  if h.state <> 'ONLINE' then
    return coalesce('the site gateway cannot capture from it and deliver: ' || h.not_ready, format('the site gateway reports it %s', h.state));
  end if;
  select * into v_contact from tab.gateway_api_contact where gateway_key_id = p_key.id;
  if found and not v_contact.reachable then
    return format('the server cannot reach the site gateway''s API (%s)', v_contact.detail);
  end if;
  if tab.chain_refusal_pending(p_key.id) then
    select a.code into v_code from tab.device_alarm a
     where a.kind = 'READING_REFUSED'
       and a.session_id in (select s.session_id from tab.gateway_session s where s.gateway_key_id = p_key.id)
     order by a.id desc limit 1;
    return format('the server refused a reading of gateway %s (%s) and has received none since, so no capture can reach it',
                  p_key.gateway_code, v_code);
  end if;
  return null;
end
$$;

-- Scales (instruments bound to an active gateway key) of a room, or of every room when p_room is null. UNKNOWN before
-- the first heartbeat; ONLINE only when nothing stops a capture (tab.scale_offline_reason); OFFLINE otherwise, with the
-- reason. As 0250 apart from the reasons after the heartbeat's own (P51) and the added field `reason`.
create or replace function tab.scale_status(p_room text) returns jsonb
language sql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'deviceCode'), '[]'::jsonb) from (
    select jsonb_build_object(
             'deviceCode', b.device_code,
             'roomCode', d.room_code,
             'status', case when h.instrument_device_id is null then 'UNKNOWN' when w.reason is null then 'ONLINE' else 'OFFLINE' end,
             'reason', w.reason,
             'lastHeartbeatUs', case when h.reported_at is null then null else platform.epoch_micros(h.reported_at)::text end,
             'gatewayCode', k.gateway_code,
             'resolution', b.resolution,
             'unit', b.unit) as x
      from tab.gateway_instrument b
      join tab.gateway_key k on k.id = b.gateway_key_id and k.status = 'ACTIVE'
      join iam.device d on d.id = b.instrument_device_id
      left join tab.instrument_heartbeat h on h.instrument_device_id = b.instrument_device_id and h.gateway_key_id = k.id
      cross join lateral (select tab.scale_offline_reason(k, b, d, h) as reason) w
     where b.ended_at is null and (p_room is null or d.room_code = p_room)) s
$$;

-- Heartbeat (INTEGRATION command, INTERFACE.WRITE): the instruments' connection states. As 0310 (room locks first),
-- except that (P51) the reason a connected instrument is not ready is stored, a state ONLINE with such a reason counts
-- as OFFLINE, the start of each such episode raises EBMR-DEV-073, the reconciliation by counts takes the higher of
-- the gateway's written watermark and what it has delivered, an unknown state counts as OFFLINE, and the answer says
-- whether the server should probe the gateway's API (probeApi).
create or replace function tab.record_heartbeat(p_heartbeat jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor     jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key       tab.gateway_key%rowtype;
  v_bind      tab.gateway_instrument%rowtype;
  v_prev      tab.instrument_heartbeat%rowtype;
  v_state     text;
  v_not_ready text;
  v_room      text;
  v_acked     text;
  v_delivered text;
  v_held      bigint;
  d           jsonb;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  for v_room in
    select distinct dv.room_code
      from jsonb_array_elements(coalesce(p_heartbeat -> 'devices', '[]'::jsonb)) x
      join tab.gateway_instrument b on b.gateway_key_id = v_key.id and b.device_code = x ->> 'deviceCode' and b.ended_at is null
      join iam.device dv on dv.id = b.instrument_device_id
     where dv.room_code is not null
     order by dv.room_code
  loop
    perform pg_advisory_xact_lock(hashtextextended('tab.scale_room:' || v_room, 0));
  end loop;
  -- DI-31: what the gateway knows the server to hold: its written watermark, or what the server acknowledged when the
  -- watermark could not be written (deliveredSeq), whichever is higher.
  v_acked := p_heartbeat #>> '{journal,ackedSeq}';
  v_delivered := p_heartbeat #>> '{journal,deliveredSeq}';
  v_held := greatest(case when v_acked ~ '^[0-9]{1,18}$' then v_acked::bigint end,
                     case when v_delivered ~ '^[0-9]{1,18}$' then v_delivered::bigint end);
  if v_held > (tab.chain_head(v_key.id) ->> 'seq')::bigint
     and not exists (select 1 from tab.device_alarm where code = 'EBMR-DEV-070' and gateway_code = v_key.gateway_code
                                                    and raised_at > clock_timestamp() - interval '1 minute') then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-070', v_key.gateway_code, null, null, (v_actor ->> 'session_id')::uuid,
      format('DI-31: the gateway counts %s readings the server acknowledged, the server holds %s; the gateway must send the missing readings again',
             v_held, tab.chain_head(v_key.id) ->> 'seq'),
      p_heartbeat -> 'journal');
  end if;
  for d in select * from jsonb_array_elements(coalesce(p_heartbeat -> 'devices', '[]'::jsonb)) loop
    select * into v_bind from tab.gateway_instrument where gateway_key_id = v_key.id and device_code = d ->> 'deviceCode' and ended_at is null;
    if not found then
      perform tab.raise_device_alarm('UNKNOWN_INSTRUMENT', 'EBMR-DEV-046', v_key.gateway_code, d ->> 'deviceCode', null,
                                     (v_actor ->> 'session_id')::uuid, 'The gateway reports an instrument that is not bound to it', d);
      continue;
    end if;
    v_state := d ->> 'state';
    if v_state is null or v_state not in ('CONNECTING', 'ONLINE', 'OFFLINE', 'SERIAL_MISMATCH') then
      v_state := 'OFFLINE';
    end if;
    if v_state = 'ONLINE' and (d ->> 'serial') is distinct from v_bind.expected_serial then
      v_state := 'SERIAL_MISMATCH';
    end if;
    -- DI-30, PR-20: a connected instrument the gateway cannot capture from and deliver is not ONLINE, whatever state
    -- the entry names.
    v_not_ready := case when jsonb_typeof(d -> 'notReady') = 'string' and btrim(d ->> 'notReady') <> '' then left(btrim(d ->> 'notReady'), 500) end;
    if v_not_ready is not null and v_state = 'ONLINE' then
      v_state := 'OFFLINE';
    end if;
    select * into v_prev from tab.instrument_heartbeat where instrument_device_id = v_bind.instrument_device_id;
    if v_state = 'SERIAL_MISMATCH' and v_prev.state is distinct from 'SERIAL_MISMATCH' then
      perform tab.raise_device_alarm('SERIAL_MISMATCH', 'EBMR-DEV-048', v_key.gateway_code, v_bind.device_code, null,
        (v_actor ->> 'session_id')::uuid,
        format('DI-20: %s answers with serial %s, not the registered %s; it is refused until the registry or the instrument is corrected',
               v_bind.device_code, coalesce(d ->> 'serial', '(none)'), v_bind.expected_serial), d);
      perform iam.raise_alert('UNREGISTERED_DEVICE', 'HIGH', null, null, v_bind.instrument_device_id, null, (v_actor ->> 'session_id')::uuid,
        jsonb_build_object('reason', 'SERIAL_MISMATCH', 'device_code', v_bind.device_code, 'expected_serial', v_bind.expected_serial,
                           'reported_serial', d ->> 'serial', 'gateway', v_key.gateway_code));
    end if;
    if v_not_ready is not null and (v_prev.not_ready is null or v_prev.gateway_key_id is distinct from v_key.id) then
      perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-073', v_key.gateway_code, v_bind.device_code, null,
        (v_actor ->> 'session_id')::uuid,
        format('DI-30: gateway %s reports %s connected but unable to capture and deliver (%s); it is shown OFFLINE until the gateway reports it ready',
               v_key.gateway_code, v_bind.device_code, v_not_ready),
        jsonb_build_object('notReady', v_not_ready, 'state', d ->> 'state'));
    end if;
    insert into tab.instrument_heartbeat (instrument_device_id, gateway_key_id, state, serial, reported_at, not_ready)
    values (v_bind.instrument_device_id, v_key.id, v_state, d ->> 'serial', clock_timestamp(), v_not_ready)
    on conflict (instrument_device_id) do update
      set gateway_key_id = excluded.gateway_key_id, state = excluded.state, serial = excluded.serial, reported_at = excluded.reported_at,
          not_ready = excluded.not_ready;
  end loop;
  return jsonb_build_object('serverTimeUs', platform.epoch_micros(clock_timestamp())::text, 'head', tab.chain_head(v_key.id),
                            'probeApi', exists (select 1 from tab.gateway_api_contact c where c.gateway_key_id = v_key.id and not c.reachable));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- P53. Ingestion as in 0270, with the reported wait bounded (EBMR-DEV-052); and (P51) the room locks while a
-- refusal holds the gateway's scales OFFLINE
-- ---------------------------------------------------------------------------------------------

create or replace function tab.ingest_reading(p_reading jsonb, p_delay_us bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor    jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key      tab.gateway_key%rowtype;
  v_bind     tab.gateway_instrument%rowtype;
  v_dev      iam.device%rowtype;
  v_existing tab.device_reading%rowtype;
  v_id       uuid;
  v_seq      bigint;
  v_head     jsonb;
  v_hash     text;
  v_db_wait  bigint;
  v_recorded_us bigint;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  begin
    v_id := (p_reading ->> 'readingId')::uuid;
    v_seq := (p_reading ->> 'seq')::bigint;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: the reading id or sequence number is malformed';
  end;
  if v_id is null or v_seq is null or v_seq < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: the reading id or sequence number is missing';
  end if;
  if p_reading ->> 'format' is distinct from 'ebmr.scale-reading.v1' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: unknown reading format';
  end if;
  if p_delay_us < 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-051 DI-28: the time a reading waited before it was received cannot be negative (%s microseconds)', p_delay_us);
  end if;
  -- DI-28: no gateway measures a wait of more than 100 years; such a value is not a wait (and would overflow below).
  if p_delay_us > 3155760000000000 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-052 DI-28: a reported wait of %s microseconds is longer than 100 years, so it is not a measured wait', p_delay_us);
  end if;

  -- Serialise ingestion per chain; the head is read under this lock.
  perform 1 from tab.gateway_key where id = v_key.id for update;

  -- Idempotent by reading id: the same reading again is a duplicate; different content under the same id is refused.
  select * into v_existing from tab.device_reading where id = v_id;
  if found then
    if v_existing.hash = p_reading ->> 'hash' and v_existing.chain_id = v_key.id then
      return jsonb_build_object('outcome', 'DUPLICATE', 'readingId', v_id, 'seq', v_existing.seq::text, 'head', tab.chain_head(v_key.id));
    end if;
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-041 DI-31: reading %s was already received with different content', v_id);
  end if;

  -- PR-20, DI-30 (P51): while a refusal holds the gateway's scales OFFLINE, this reading ends the hold and turns them
  -- ONLINE; serialised with hand-keyed weighings of their rooms (0310).
  if tab.chain_refusal_pending(v_key.id) then
    perform tab.lock_gateway_rooms(v_key.id);
  end if;

  if (p_reading ->> 'chainId') is distinct from v_key.id::text or (p_reading ->> 'gatewayCode') is distinct from v_key.gateway_code then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-042 DI-31: the reading belongs to chain %s of %s, not to this gateway''s enrolment', p_reading ->> 'chainId', p_reading ->> 'gatewayCode');
  end if;
  if (p_reading ->> 'installation') is distinct from kernel.installation_kind() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-043 DI-20: a %s reading cannot enter a %s installation', p_reading ->> 'installation', kernel.installation_kind());
  end if;

  v_head := tab.chain_head(v_key.id);
  if v_seq <> (v_head ->> 'seq')::bigint + 1 or (p_reading ->> 'prevHash') is distinct from (v_head ->> 'hash') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-044 DI-31: sequence break: the server holds up to %s, the reading is %s', v_head ->> 'seq', v_seq);
  end if;
  v_hash := encode(sha256(convert_to(tab.reading_canonical_text(p_reading), 'UTF8')), 'hex');
  if v_hash is distinct from p_reading ->> 'hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-045 DI-31: the reading hash does not match its content';
  end if;

  select * into v_bind from tab.gateway_instrument
   where gateway_key_id = v_key.id and device_code = p_reading ->> 'deviceCode' and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-046 DI-20: %s is not an instrument of gateway %s', p_reading ->> 'deviceCode', v_key.gateway_code);
  end if;
  select * into v_dev from iam.device where id = v_bind.instrument_device_id;
  if v_dev.status <> 'ACTIVE' or v_dev.device_class <> 'INSTRUMENT' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-047 DI-20: instrument %s is %s', v_dev.code, v_dev.status);
  end if;
  if (p_reading ->> 'serial') is distinct from v_bind.expected_serial then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-048 DI-20: serial %s is not the registered serial of %s', p_reading ->> 'serial', v_dev.code);
  end if;
  if (p_reading ->> 'unit') is not null and (p_reading ->> 'unit') <> v_bind.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-049 DI-31: unit %s is not the configured unit %s of %s', p_reading ->> 'unit', v_bind.unit, v_dev.code);
  end if;
  if (p_reading ->> 'value') is not null
     and (not tab.is_decimal_text(p_reading ->> 'value') or mod((p_reading ->> 'value')::numeric, v_bind.resolution::numeric) <> 0) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-050 DI-31: value %s is not a multiple of the resolution %s', p_reading ->> 'value', v_bind.resolution);
  end if;

  -- DI-28: the wait inside the database, from the start of this transaction to the insert: the command's validation,
  -- whatever the caller did or waited on in the transaction before this statement, and the chain lock.
  v_db_wait := greatest(platform.epoch_micros(clock_timestamp()) - platform.epoch_micros(transaction_timestamp()), 0);
  insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                  stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                  uplink_delay_us, ingest_session_id, correlation_id)
  values (v_id, v_key.id, v_seq, v_key.gateway_device_id, v_key.gateway_code, v_dev.id, v_dev.code, p_reading ->> 'serial',
          p_reading ->> 'value', p_reading ->> 'unit', (p_reading ->> 'stable')::boolean, p_reading ->> 'status', p_reading ->> 'raw',
          (p_reading ->> 'sourceTimeUs')::bigint, p_reading ->> 'trust', p_reading ->> 'installation', p_reading ->> 'purpose',
          p_reading ->> 'prevHash', v_hash, p_reading ->> 'signature', p_delay_us + v_db_wait,
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning recorded_us into v_recorded_us;
  perform kernel.audit_business_event('device_reading:' || v_id,
    format('Scale reading %s from %s via gateway %s: %s (%s), raw "%s"', v_seq, v_dev.code, v_key.gateway_code,
           coalesce((p_reading ->> 'value') || ' ' || (p_reading ->> 'unit'), 'no value'), p_reading ->> 'status', p_reading ->> 'raw'),
    jsonb_build_object('chain_id', v_key.id, 'seq', v_seq, 'hash', v_hash, 'purpose', p_reading ->> 'purpose',
                       'reported_wait_us', p_delay_us, 'database_wait_us', v_db_wait));
  return jsonb_build_object('outcome', 'INGESTED', 'readingId', v_id, 'seq', v_seq::text, 'head', tab.chain_head(v_key.id),
                            'recordedUs', v_recorded_us::text);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- P53. Claims as in 0270, with the signed capture time of a DEVICE_SYNCED reading bounding its age
-- ---------------------------------------------------------------------------------------------

create or replace function tab.claim_readings(p_ids uuid[], p_room text, p_max_age_us bigint, p_purpose text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor     jsonb := iam.assert_validated_actor();
  v_scope     jsonb;
  v_room      text;
  v_eval      jsonb;
  v_r         tab.device_reading%rowtype;
  v_loc       jsonb;
  v_problem   jsonb;
  v_now       bigint := platform.epoch_micros(clock_timestamp());
  v_age       numeric;
  v_tolerance numeric;
  v_out       jsonb := '[]'::jsonb;
  v_id        uuid;
begin
  perform iam.assert_not_administrator();
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-100 DI-31: only a person''s entry can use a scale reading';
  end if;
  -- The person must be able to execute steps (or dispense) where they are.
  v_scope := iam.actor_location_scope();
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'DISPENSE.EXECUTE', v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if not (v_eval ->> 'allowed')::boolean then
    perform iam.require_permission('STEP.EXECUTE', v_scope);
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-101 no reading ids to claim';
  end if;
  if (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) or array_position(p_ids, null) is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-107 DI-32: a reading can be used only once, and each id only once per entry';
  end if;
  -- DI-20: the room is the one of the actor's session (its enrolled terminal's room when the session opened), never
  -- the caller's word; the room the caller names must be that same room.
  v_room := v_scope ->> 'area';
  if v_room is null or p_room is null or btrim(p_room) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-103 DI-20: a scale reading can be used only on a terminal registered to a room';
  end if;
  if p_room <> v_room then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-103 DI-20: the claim names room %s, but the terminal of this session is in room %s', p_room, v_room);
  end if;
  if p_max_age_us is null or p_max_age_us <= 0 or p_max_age_us > 3600000000 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-108 the maximum reading age must be between 1 microsecond and 1 hour';
  end if;
  if coalesce(btrim(p_purpose), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-106 a claim names its purpose';
  end if;
  -- DI-28 (P53): the tolerance between the database clock and a gateway's synchronised clock: each may be off the
  -- common reference by up to the site's drift alarm threshold.
  v_tolerance := 2 * platform.setting_numeric('time.drift_alarm_threshold_s') * 1000000;

  foreach v_id in array p_ids loop
    select * into v_r from tab.device_reading where id = v_id;
    if not found then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-101 DI-32: reading %s does not exist', v_id);
    end if;
    -- DI-31, DI-32: the stored reading still carries its proof (hash, gateway signature, raw line).
    v_problem := tab.device_reading_problem(v_r);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-110 DI-31: reading %s cannot be used: %s', v_id, v_problem ->> 'message');
    end if;
    if v_r.status <> 'OK' or not v_r.stable or v_r.value is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-102 DI-32: reading %s is %s, not a stable weight', v_id, v_r.status);
    end if;
    if v_r.installation <> kernel.installation_kind() then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-043 DI-20: reading %s is from a %s installation', v_id, v_r.installation);
    end if;
    v_loc := iam.check_device_location(v_r.instrument_device_id, v_room, null);
    if not (v_loc ->> 'accepted')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-103 DI-20: reading %s comes from %s (%s), which is not an active instrument of room %s',
                         v_id, v_r.device_code, coalesce(v_loc ->> 'reason', 'refused'), v_room);
    end if;
    if not exists (select 1 from iam.device where id = v_r.instrument_device_id and device_class = 'INSTRUMENT') then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-103 DI-20: %s is not an instrument', v_r.device_code);
    end if;
    if not exists (select 1 from tab.gateway_key k join tab.gateway_instrument b on b.gateway_key_id = k.id
                    where k.id = v_r.chain_id and k.status = 'ACTIVE' and b.instrument_device_id = v_r.instrument_device_id
                      and b.ended_at is null) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-109 DI-31: reading %s came through a gateway key or instrument binding that is no longer active', v_id);
    end if;
    v_age := case when v_r.uplink_delay_us is null then null else v_now::numeric - v_r.recorded_us + v_r.uplink_delay_us end;
    if v_age is null or v_age > p_max_age_us then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-104 DI-28: reading %s is too old to use (older than %s s, or its capture time is not known); take a new reading',
                         v_id, round(p_max_age_us / 1000000.0, 1));
    end if;
    -- DI-28 (P53): a reading taken on a synchronised clock carries a capture time the gateway signed; its age by that
    -- time bounds whatever wait was reported for it, including a wait before the ingesting transaction began.
    if v_r.trust = 'DEVICE_SYNCED' and v_now::numeric - v_r.source_time_us > p_max_age_us + v_tolerance then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-104 DI-28: reading %s was captured %s s ago by the gateway''s synchronised clock, more than %s s plus a clock tolerance of %s s; take a new reading',
                         v_id, round((v_now::numeric - v_r.source_time_us) / 1000000.0, 1), round(p_max_age_us / 1000000.0, 1),
                         round(v_tolerance / 1000000.0, 3));
    end if;
    if p_purpose in ('TARE', 'GROSS', 'CHECK') and v_r.purpose is not null and v_r.purpose <> p_purpose then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-106 DI-32: reading %s was taken as %s and cannot be used as %s', v_id, v_r.purpose, p_purpose);
    end if;
    begin
      insert into tab.reading_use (reading_id, purpose, room_code, person_id, account_id, session_id, correlation_id)
      values (v_id, p_purpose, v_room, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
              (v_actor ->> 'correlation_id')::uuid);
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-105 DI-32: reading %s has already been used', v_id);
    end;
    perform kernel.audit_business_event('device_reading:' || v_id,
      format('Scale reading %s %s from %s used as %s in room %s', v_r.value, v_r.unit, v_r.device_code, p_purpose, v_room),
      jsonb_build_object('purpose', p_purpose, 'room', v_room));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'readingId', v_id, 'value', v_r.value, 'unit', v_r.unit, 'raw', v_r.raw, 'deviceCode', v_r.device_code,
      'sourceTimeUs', v_r.source_time_us::text, 'trust', v_r.trust));
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- P49. The durable alert of a claim refused for the room, in a command of its own after the rollback
-- ---------------------------------------------------------------------------------------------

-- Inside a validated command of a person entitled to use readings where they are (as tab.claim_readings asks), after
-- that person's claim of p_ids naming p_room was refused for the room and rolled back. The session, the person and the
-- session's room come from the validated actor; the balance's room and status from the registry; p_room is recorded as
-- the room the refused claim named. For each existing reading whose balance is not ACTIVE (BLOCKED_DEVICE_USE), is not
-- an instrument of the session's room, or was claimed for another room than the session's (DEVICE_LOCATION_MISMATCH),
-- it raises the alert and a CLAIM_REFUSED alarm, both naming the session, at most once per reading and session.
-- Returns the number of readings alerted.
create function tab.alert_refused_claim(p_ids uuid[], p_room text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_scope   jsonb;
  v_eval    jsonb;
  v_session uuid;
  v_room    text;
  v_r       tab.device_reading%rowtype;
  v_dev     iam.device%rowtype;
  v_kind    text;
  v_why     text;
  n         integer := 0;
begin
  perform iam.assert_not_administrator();
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-100 DI-31: only a person''s refused use of a scale reading is alerted';
  end if;
  v_scope := iam.actor_location_scope();
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'DISPENSE.EXECUTE', v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if not (v_eval ->> 'allowed')::boolean then
    perform iam.require_permission('STEP.EXECUTE', v_scope);
  end if;
  v_session := (v_actor ->> 'session_id')::uuid;
  v_room := v_scope ->> 'area';
  for v_r in select * from tab.device_reading where id = any(coalesce(p_ids, '{}')) order by id loop
    select * into v_dev from iam.device where id = v_r.instrument_device_id;
    v_kind := null;
    if v_dev.status <> 'ACTIVE' then
      v_kind := 'BLOCKED_DEVICE_USE';
      v_why := format('%s is %s in the device registry', v_dev.code, v_dev.status);
    elsif v_room is null or v_dev.room_code is distinct from v_room then
      v_kind := 'DEVICE_LOCATION_MISMATCH';
      v_why := format('the balance of room %s was to be used from a terminal %s', coalesce(v_dev.room_code, '-'),
                      case when v_room is null then 'registered to no room' else 'of room ' || v_room end);
    elsif p_room is distinct from v_room then
      v_kind := 'DEVICE_LOCATION_MISMATCH';
      v_why := format('the claim named room %s, not room %s of the session''s terminal', coalesce(p_room, '-'), v_room);
    end if;
    continue when v_kind is null;
    continue when exists (select 1 from tab.device_alarm a
                           where a.kind = 'CLAIM_REFUSED' and a.session_id = v_session and a.reading_id = v_r.id::text);
    perform iam.raise_alert(v_kind, 'HIGH', (v_actor ->> 'account_id')::uuid, (v_actor ->> 'person_id')::uuid, v_dev.id, null, v_session,
      jsonb_build_object('reading_id', v_r.id, 'registered_room', v_dev.room_code, 'session_room', v_room, 'requested_room', p_room,
                         'status', v_dev.status));
    perform tab.raise_device_alarm('CLAIM_REFUSED', 'EBMR-DEV-103', v_r.gateway_code, v_r.device_code, v_r.id::text, v_session,
      format('DI-20: reading of %s refused: %s', v_r.device_code, v_why),
      jsonb_build_object('status', v_dev.status, 'registered_room', v_dev.room_code, 'session_room', v_room, 'requested_room', p_room));
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function tab.record_gateway_api_contact(text, boolean, text), tab.alert_refused_claim(uuid[], text),
  tab.scale_offline_reason(tab.gateway_key, tab.gateway_instrument, iam.device, tab.instrument_heartbeat),
  tab.lock_gateway_rooms(uuid), tab.chain_refusal_pending(uuid) from public;
grant execute on function tab.record_gateway_api_contact(text, boolean, text), tab.alert_refused_claim(uuid[], text) to ebmr_app;
-- P49: the 0250 alert takes its facts from the caller's arguments and no actor; the application role no longer runs it.
revoke execute on function tab.alert_claim_refusal(uuid[], text, text) from ebmr_app;

reset role;
