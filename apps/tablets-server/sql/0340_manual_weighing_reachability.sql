-- Tablets server, modules C3 with C5: the manual-weighing gate opens only on a report that is committed before the
-- weighing's transaction and has stood for the heartbeat window, a report that the server cannot reach a gateway's API
-- has an author, and the gate records with the weighing why the manual path was open (round-3 verification of review
-- finding P50/P51; controls DI-14, DI-17, DI-20, DI-30, DI-32, PR-20).
--
-- The problem. 0320 let the application role record, through tab.record_gateway_api_contact(code, false, detail) and
-- with no actor, permission or command, that the server cannot reach a gateway's API. That one report showed every
-- scale of the gateway OFFLINE (tab.scale_offline_reason), and the 0310 gate (tab.manual_weighing_check) then took
-- hand-keyed weights. So a writer with only the application's database credentials could, inside the command that
-- writes the weighing, report the API unreachable, write a MANUAL weighing beside a scale whose heartbeat was ONLINE
-- the whole time, report the API reachable again and commit: the scales read ONLINE before and after, and the only
-- trace was two gateway alarms. A READING_REFUSED alarm (tab.record_gateway_refusal, tab.chain_refusal_pending) is the
-- same kind of lever, and so is a heartbeat written in the weighing's own transaction under the live gateway
-- session's actor (which the application role can build from iam.session; heartbeats carry no gateway signature).
--
-- Now:
-- 1. The gate derives the room's scale statuses as tab.scale_status does, with one difference: a report that the
--    server cannot reach the gateway's API, or a refused reading of the gateway's chain, counts as a reason the scale
--    is offline only when it was written before the weighing's transaction began and has lasted at least the heartbeat
--    window (10 seconds, the window of tab.scale_offline_reason): the API report's last change (changed_at), or the
--    first refusal after the chain's last ingested reading (raised_at), is older than the transaction's start minus
--    10 seconds. A report written in the transaction itself is always younger, so the in-transaction toggle is
--    refused; otherwise the heartbeat decides, and a scale whose heartbeat says ONLINE refuses the MANUAL weighing
--    (EBMR-EXE-074). An episode that opens the manual path was therefore written at least 10 seconds before the
--    weighing, and while it is committed every heartbeat of the gateway has the server probe the API again (0320,
--    probeApi). tab.scale_status itself is unchanged: the capture is refused as soon as the report is made, and the
--    manual path opens 10 seconds later.
--    A heartbeat of a scale of the room written in the weighing's own transaction (tab.instrument_heartbeat now keeps
--    the top-level transaction that wrote it, written_xact, so a savepoint does not hide it) refuses the weighing too
--    (EBMR-EXE-074): the gate takes a scale's status only from what other transactions reported.
-- 2. The report has an author. tab.record_gateway_api_contact requires a validated actor holding the new permission
--    GATEWAY.API_CONTACT_RECORD, which only the new role GATEWAY_API_MONITOR holds (SERVICE accounts only, nothing
--    else in it; DI-17). The server records every observation of a gateway's API through the service identity of its
--    gateway API monitor (in the sandbox TEST-gw-monitor on the SERVER terminal TEST-SRV-MONITOR, granted the role
--    by an administrator's request and the process owner's approval, like every grant). Each change of state is an
--    audit entry of the gateway key's chain (gateway_key:<id>) attributed to that identity, and its alarms
--    (EBMR-DEV-071, EBMR-DEV-072) carry its session. A person, the gateway, an administrator or a call outside a
--    command cannot record it (EBMR-IAM-040, EBMR-IAM-001/002). This migration grants no role to anyone.
-- 3. The gate writes, from the database, the statuses it decided on into tab.manual_weighing_basis, one row per
--    hand-keyed weighing row it lets through (the batch, the row's seq, the room, and for every scale of the room
--    its status, the reason it was offline as the gate counted it, and its last heartbeat). The row is insert-only,
--    audited in the batch's chain (batch:<id>) with the command's actor, and linked to the execution row (checked at
--    commit: the execution row is inserted after its BEFORE triggers). The execution row itself cannot carry it: its
--    hash is computed before the insert (recipe-core 0210, 0285).
-- 4. READING_REFUSED holds follow rule 1 in the gate (tab.chain_refusal_held with the same bound).
--    tab.chain_refusal_pending, which tab.ingest_reading reads to decide whether to take the room locks before it
--    ends a hold, keeps counting every pending refusal whatever its age (the stricter reading for that lock).
--
-- What stays open (docs/decisions/phase-2-open-questions.md): a heartbeat that reports a scale not online, committed in
-- a transaction of its own, still opens the manual path at once (the heartbeat decides); the age of a report is
-- counted from its write, not from its commit; administration acts on the registry (a device blocked or re-registered,
-- a binding ended) are out of scope as in 0310.
--
-- Privileges: every function is SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016). CREATE OR REPLACE
-- keeps the owner, search_path and grants of tab.manual_weighing_check (none), tab.record_gateway_api_contact
-- (EXECUTE for ebmr_app), tab.record_heartbeat (EXECUTE for ebmr_app), tab.scale_offline_reason and
-- tab.chain_refusal_pending (none). The new helpers are granted to nobody; ebmr_app may read tab.manual_weighing_basis.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 2. Catalogue: the permission and the role of the server's gateway API monitor (under the software release)
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0340_manual_weighing_reachability)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'whether the server reaches a site gateway''s API is recorded only by the server''s own monitor identity, in a role that holds nothing else (DI-17, DI-30, PR-20)'));

insert into iam.permission (code, domain, effect, description) values
  ('GATEWAY.API_CONTACT_RECORD', 'GMP', 'WRITE',
   'Record whether the server reaches the API of a site gateway (the server''s gateway API monitor, a system service account); while it cannot, the gateway''s scales are shown offline');

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('GATEWAY_API_MONITOR', 'Gateway API monitor', 'EXECUTION',
   'In-process service of the server that records whether it reaches each site gateway''s API; never signs, never logs in interactively',
   array['SERVICE'], false);

insert into iam.role_permission (role_code, permission_code) values ('GATEWAY_API_MONITOR', 'GATEWAY.API_CONTACT_RECORD');

do $$
begin
  if iam.role_permissions_at('GATEWAY_API_MONITOR', clock_timestamp()) is distinct from array['GATEWAY.API_CONTACT_RECORD'] then
    raise exception using errcode = 'P0001', message = 'GATEWAY_API_MONITOR must hold GATEWAY.API_CONTACT_RECORD and nothing else (DI-17, INV-20)';
  end if;
  if exists (select 1 from iam.role_permission
             where permission_code = 'GATEWAY.API_CONTACT_RECORD' and removed_at is null and role_code <> 'GATEWAY_API_MONITOR') then
    raise exception using errcode = 'P0001', message = 'GATEWAY.API_CONTACT_RECORD is held by a role other than GATEWAY_API_MONITOR (DI-17, INV-20)';
  end if;
end
$$;

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- 2. What the server observed calling a gateway's API, recorded by its monitor
-- ---------------------------------------------------------------------------------------------

-- What the server observed calling the API of the gateway p_gateway_code (its ACTIVE key): reached or not. As 0320,
-- except that (round 3) the caller is the validated actor of a command holding GATEWAY.API_CONTACT_RECORD (the
-- server's gateway API monitor), never an administrator; each change of state is audited in the gateway key's chain
-- under that actor, and its alarm carries the actor's session. A failure after a success (or first of all) raises
-- EBMR-DEV-071, a success after a failure EBMR-DEV-072; a success while the API counts as reachable writes nothing.
-- True when the state was written.
create or replace function tab.record_gateway_api_contact(p_gateway_code text, p_reachable boolean, p_detail text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_actor   jsonb := iam.require_permission('GATEWAY.API_CONTACT_RECORD', '{}'::jsonb);
  v_session uuid;
  v_key     tab.gateway_key%rowtype;
  v_prev    tab.gateway_api_contact%rowtype;
  v_detail  text;
begin
  perform iam.assert_not_administrator();
  v_session := (v_actor ->> 'session_id')::uuid;
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
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-071', v_key.gateway_code, null, null, v_session,
      format('DI-30: the server cannot reach the API of gateway %s (%s); its instruments are shown OFFLINE, so weights may be keyed by hand with a second person''s check once this has lasted 10 seconds, until the server reaches it again',
             v_key.gateway_code, v_detail),
      jsonb_build_object('detail', v_detail));
    perform kernel.audit_business_event('gateway_key:' || v_key.id,
      format('The server cannot reach the API of gateway %s (%s): its scales are shown offline', v_key.gateway_code, v_detail),
      jsonb_build_object('gateway_code', v_key.gateway_code, 'reachable', false, 'detail', v_detail, 'alarm', 'EBMR-DEV-071'));
  elsif p_reachable then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-072', v_key.gateway_code, null, null, v_session,
      format('DI-30: the server reaches the API of gateway %s again (%s); its instruments follow its heartbeats again', v_key.gateway_code, v_detail),
      jsonb_build_object('detail', v_detail, 'unreachable_since', v_prev.changed_at));
    perform kernel.audit_business_event('gateway_key:' || v_key.id,
      format('The server reaches the API of gateway %s again (%s): its scales follow their heartbeats again', v_key.gateway_code, v_detail),
      jsonb_build_object('gateway_code', v_key.gateway_code, 'reachable', true, 'detail', v_detail, 'alarm', 'EBMR-DEV-072',
                         'unreachable_since', v_prev.changed_at));
  end if;
  return true;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 1, 4. Reasons a scale is offline, counting the server's reports only from a given age
-- ---------------------------------------------------------------------------------------------

-- True while the server has refused a reading of the chain of gateway key p_key and ingested none since, and the
-- first such refusal was raised before p_before (the hold has stood since then). p_before = 'infinity': any refusal.
create function tab.chain_refusal_held(p_key uuid, p_before timestamptz) returns boolean
language sql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
  select exists (
    select 1 from tab.device_alarm a
     where a.kind = 'READING_REFUSED'
       and a.session_id in (select s.session_id from tab.gateway_session s where s.gateway_key_id = p_key)
       and a.raised_at > coalesce((select r.recorded_at from tab.device_reading r where r.chain_id = p_key order by r.seq desc limit 1),
                                  '-infinity'::timestamptz)
       and a.raised_at < p_before)
$$;

-- As 0320: true while any refusal holds the chain (the room locks of tab.ingest_reading follow this, whatever its age).
create or replace function tab.chain_refusal_pending(p_key uuid) returns boolean
language sql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
  select tab.chain_refusal_held(p_key, 'infinity'::timestamptz)
$$;

-- Why the scale bound by p_bind (instrument p_device, gateway key p_key, last heartbeat h of that key, or null) cannot
-- be captured from, as tab.scale_offline_reason (0320) says it, except that the server's two reports count only when
-- made before p_reported_before: the API marked unreachable (its last change of state) and a refused reading of the
-- key's chain (the first refusal since the chain's last ingested reading). Null when nothing (so counted) stops a
-- capture.
create function tab.scale_offline_reason_at(p_key tab.gateway_key, p_bind tab.gateway_instrument, p_device iam.device,
                                            h tab.instrument_heartbeat, p_reported_before timestamptz)
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
  if found and not v_contact.reachable and v_contact.changed_at < p_reported_before then
    return format('the server cannot reach the site gateway''s API (%s)', v_contact.detail);
  end if;
  if tab.chain_refusal_held(p_key.id, p_reported_before) then
    select a.code into v_code from tab.device_alarm a
     where a.kind = 'READING_REFUSED'
       and a.session_id in (select s.session_id from tab.gateway_session s where s.gateway_key_id = p_key.id)
       and a.raised_at < p_reported_before
     order by a.id desc limit 1;
    return format('the server refused a reading of gateway %s (%s) and has received none since, so no capture can reach it',
                  p_key.gateway_code, v_code);
  end if;
  return null;
end
$$;

-- As 0320 (what tab.scale_status shows, and so what the capture follows): every report counts at once.
create or replace function tab.scale_offline_reason(p_key tab.gateway_key, p_bind tab.gateway_instrument, p_device iam.device, h tab.instrument_heartbeat)
returns text
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  return tab.scale_offline_reason_at(p_key, p_bind, p_device, h, 'infinity'::timestamptz);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. Heartbeats record the transaction that wrote them
-- ---------------------------------------------------------------------------------------------

-- The top-level transaction that wrote the heartbeat (pg_current_xact_id(), the same inside a savepoint); null for a
-- row written before this migration.
alter table tab.instrument_heartbeat add column written_xact xid8;

-- Heartbeat (INTEGRATION command, INTERFACE.WRITE): as 0320, and the row keeps the transaction that wrote it.
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
    insert into tab.instrument_heartbeat (instrument_device_id, gateway_key_id, state, serial, reported_at, not_ready, written_xact)
    values (v_bind.instrument_device_id, v_key.id, v_state, d ->> 'serial', clock_timestamp(), v_not_ready, pg_current_xact_id())
    on conflict (instrument_device_id) do update
      set gateway_key_id = excluded.gateway_key_id, state = excluded.state, serial = excluded.serial, reported_at = excluded.reported_at,
          not_ready = excluded.not_ready, written_xact = excluded.written_xact;
  end loop;
  return jsonb_build_object('serverTimeUs', platform.epoch_micros(clock_timestamp())::text, 'head', tab.chain_head(v_key.id),
                            'probeApi', exists (select 1 from tab.gateway_api_contact c where c.gateway_key_id = v_key.id and not c.reachable));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. The scales of a room as the gate counts them
-- ---------------------------------------------------------------------------------------------

-- The scales of room p_room (instruments bound to an active gateway key), for the gate of a hand-keyed weighing in the
-- current transaction: status UNKNOWN before the first heartbeat, OFFLINE with the reason tab.scale_offline_reason_at
-- counts for reports written before the transaction's start minus 10 seconds, else ONLINE. Also: `shownReason`, what
-- tab.scale_status shows now (it differs when a younger report is not counted), and `heartbeatInThisTransaction`.
create function tab.manual_weighing_scales(p_room text) returns jsonb
language sql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'deviceCode'), '[]'::jsonb) from (
    select jsonb_build_object(
             'deviceCode', b.device_code,
             'gatewayCode', k.gateway_code,
             'status', case when h.instrument_device_id is null then 'UNKNOWN' when g.reason is null then 'ONLINE' else 'OFFLINE' end,
             'reason', g.reason,
             'shownReason', w.reason,
             'lastHeartbeatUs', case when h.reported_at is null then null else platform.epoch_micros(h.reported_at)::text end,
             'heartbeatInThisTransaction', coalesce(h.written_xact = pg_current_xact_id_if_assigned(), false)) as x
      from tab.gateway_instrument b
      join tab.gateway_key k on k.id = b.gateway_key_id and k.status = 'ACTIVE'
      join iam.device d on d.id = b.instrument_device_id
      left join tab.instrument_heartbeat h on h.instrument_device_id = b.instrument_device_id and h.gateway_key_id = k.id
      cross join lateral (select tab.scale_offline_reason(k, b, d, h) as reason) w
      cross join lateral (select tab.scale_offline_reason_at(k, b, d, h, transaction_timestamp() - interval '10 seconds') as reason) g
     where b.ended_at is null and d.room_code = p_room) s
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Why the manual path was open, recorded with the weighing
-- ---------------------------------------------------------------------------------------------

create table tab.manual_weighing_basis (
  batch_id     uuid not null,
  row_seq      bigint not null,
  room_code    text not null,
  -- [{deviceCode, gatewayCode, status, reason, lastHeartbeatUs}] for every scale of the room, as the gate counted them.
  scales       jsonb not null check (jsonb_typeof(scales) = 'array'),
  recorded_at  timestamptz not null default clock_timestamp(),
  primary key (batch_id, row_seq),
  -- Checked at commit: the gate writes this row from the BEFORE INSERT trigger of the execution row.
  foreign key (batch_id, row_seq) references recipe.execution_command (batch_id, seq) deferrable initially deferred
);
revoke all on tab.manual_weighing_basis from public;
select kernel.register_audited_table('tab.manual_weighing_basis', 'batch', 'batch_id', true);
select platform.enforce_db_time('tab.manual_weighing_basis', array['recorded_at']);
grant select on tab.manual_weighing_basis to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- 1, 3. The gate
-- ---------------------------------------------------------------------------------------------

-- As 0310, except that the statuses are those of tab.manual_weighing_scales (the server's reports count from 10 seconds
-- before the transaction), a heartbeat written in this transaction refuses the weighing, and a weighing let through is
-- recorded in tab.manual_weighing_basis with the statuses that let it through.
create or replace function tab.manual_weighing_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_entry   jsonb := new.command -> 'entry';
  v_source  text;
  v_balance text;
  v_scales  jsonb;
  v_scale   jsonb;
begin
  if new.kind <> 'COMMAND' or new.command_type <> 'RECORD_ENTRY' or jsonb_typeof(v_entry) is distinct from 'object'
     or not (coalesce(v_entry ->> 'kind', '') in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER') or v_entry ? 'balance') then
    return new;
  end if;
  v_source := case when jsonb_typeof(v_entry -> 'source') = 'string' then v_entry ->> 'source' end;
  if v_source = 'DEVICE' then
    return new;
  end if;
  if v_source is distinct from 'MANUAL' then
    raise exception using errcode = 'P0001',
      message = format('A weighing is either captured from a device (DEVICE) or keyed by hand (MANUAL); source %s is neither, so the database cannot tell which rules apply (DI-30, DI-32). [EBMR-EXE-121]',
                       coalesce(v_entry ->> 'source', '(none)'));
  end if;
  if new.room_code is null then
    raise exception using errcode = 'P0001',
      message = 'A weight keyed by hand is accepted only from a terminal registered to a room, where the scales it stands in for are known (DI-20, DI-32, PR-20). [EBMR-EXE-074]';
  end if;
  -- Serialised with the heartbeats of the room (tab.record_heartbeat); held to the commit, never waited for.
  if not pg_try_advisory_xact_lock_shared(hashtextextended('tab.scale_room:' || new.room_code, 0)) then
    raise exception using errcode = 'P0001',
      message = format('A scale of room %s is reporting its status at this moment, so whether it is online is not yet known; nothing is keyed by hand until it is. Try again (DI-30, PR-20). [EBMR-EXE-074]', new.room_code);
  end if;
  v_scales := tab.manual_weighing_scales(new.room_code);
  -- A status reported inside this very transaction is not another party's report: it never opens the manual path.
  select x into v_scale from jsonb_array_elements(v_scales) x
   where (x ->> 'heartbeatInThisTransaction')::boolean
   order by x ->> 'deviceCode' limit 1;
  if v_scale is not null then
    raise exception using errcode = 'P0001',
      message = format('The status of scale %s of room %s was reported in the same transaction as this weight keyed by hand; the database takes a scale''s status only from reports committed before, so nothing is keyed by hand on it (DI-30, PR-20). [EBMR-EXE-074]',
                       v_scale ->> 'deviceCode', new.room_code);
  end if;
  select x into v_scale from jsonb_array_elements(v_scales) x
   where x ->> 'status' = 'ONLINE'
   order by x ->> 'deviceCode' limit 1;
  if v_scale is not null then
    if v_scale ->> 'shownReason' is not null then
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is online by its heartbeat. The report that it cannot be used (%s) was made in this transaction or less than 10 seconds before it began, so it does not open the manual path yet: capture the weight from the scale, or key it by hand once the report has stood for 10 seconds (DI-30, PR-20). [EBMR-EXE-074]',
                         v_scale ->> 'deviceCode', new.room_code, v_scale ->> 'shownReason');
    end if;
    raise exception using errcode = 'P0001',
      message = format('Scale %s of room %s is online: the weight is captured from it, never keyed by hand (DI-30, PR-20). [EBMR-EXE-074]', v_scale ->> 'deviceCode', new.room_code);
  end if;
  v_balance := case when jsonb_typeof(v_entry -> 'balance') = 'string' then v_entry ->> 'balance' end;
  if v_balance is distinct from 'MANUAL'
     and not exists (select 1 from iam.device d
                      where d.code = v_balance and d.device_class = 'INSTRUMENT' and d.status = 'ACTIVE' and d.room_code = new.room_code) then
    raise exception using errcode = 'P0001',
      message = format('A weight keyed by hand names balance %s, which is not an active instrument of room %s; it names MANUAL or the balance of the room that was read (DI-20, DI-30). [EBMR-EXE-074]',
                       coalesce(v_entry ->> 'balance', '(none)'), new.room_code);
  end if;
  insert into tab.manual_weighing_basis (batch_id, row_seq, room_code, scales)
  values (new.batch_id, new.seq, new.room_code,
          (select coalesce(jsonb_agg(x - 'shownReason' - 'heartbeatInThisTransaction' order by x ->> 'deviceCode'), '[]'::jsonb)
             from jsonb_array_elements(v_scales) x));
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function tab.chain_refusal_held(uuid, timestamptz),
  tab.scale_offline_reason_at(tab.gateway_key, tab.gateway_instrument, iam.device, tab.instrument_heartbeat, timestamptz),
  tab.manual_weighing_scales(text) from public;

reset role;
