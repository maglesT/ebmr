-- Tablets server, module C3 with C5: a weighing keyed by hand is recorded only when no scale of the terminal's room is
-- online, from a terminal registered to a room, and naming as its balance either MANUAL or an active instrument of that
-- room (review finding P50, round-1 verification; controls DI-20, DI-30, DI-32, PR-20).
--
-- The G-07/G-22 manual two-person path is the fallback for a scale that cannot be used. Until now the only guard that
-- refused hand-keyed tare and gross beside an ONLINE scale was TypeScript (execution/intents.ts, EBMR-EXE-074), and it
-- read the scale status on its own connection, before the command's transaction. So a scale that came online between
-- that read and the commit was missed, and a writer with the application role (or a server bug) could record a MANUAL
-- weighing while a scale of the room was online. This migration moves the rule into the database:
--
-- 1. tab.manual_weighing_check(), a BEFORE INSERT row trigger on recipe.execution_command (ac_tab_manual_weighing,
--    after the recipe check ab_execution_source_room). For a COMMAND row of type RECORD_ENTRY that records a weighing
--    (entry kind CONTAINER_WEIGHING or OUTPUT_CONTAINER, or any entry naming a balance), accepted or refused alike:
--      EBMR-EXE-121  the entry's source is neither DEVICE nor MANUAL (a weighing is captured or keyed, nothing else;
--                    a DEVICE entry is checked by recipe-core 0300 and tablets 0300);
--      EBMR-EXE-074  a MANUAL weighing
--                    * from a terminal registered to no room (the scales it would stand in for are unknown);
--                    * while a scale of the room is reporting its status at this very moment (try again);
--                    * while any scale of the room is ONLINE (tab.scale_status, read inside the command's
--                      transaction at database time);
--                    * naming a balance that is neither MANUAL nor an ACTIVE instrument registered to the room.
-- 2. Heartbeats and hand-keyed weighings of a room are serialised: tab.record_heartbeat (0250, replaced here with one
--    addition) takes an exclusive transaction lock per room it reports on, in room order, before it writes; the check
--    takes the same lock in shared mode, without waiting, before it reads the statuses, and keeps it to the commit.
--    A heartbeat that starts after the check waits for the weighing's commit, so no scale of the room turns ONLINE
--    between the check and the commit; a weighing checked while a heartbeat of its room is being written is refused
--    (never waits: no lock cycle with the heartbeat is possible).
--
-- Out of scope here: an administrator re-registering a device to the room, unblocking it or binding it while the check
-- runs (administration acts, not status reports), and the readability and capacity of the balance for the quantity
-- weighed (the MBR has no field for them yet; open question for the designer).
--
-- Privileges: both functions are SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016). Nobody executes the
-- trigger function directly; CREATE OR REPLACE keeps tab.record_heartbeat's owner and grants.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The gate
-- ---------------------------------------------------------------------------------------------

create function tab.manual_weighing_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_entry   jsonb := new.command -> 'entry';
  v_source  text;
  v_balance text;
  v_online  text;
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
  select x ->> 'deviceCode' into v_online
    from jsonb_array_elements(tab.scale_status(new.room_code)) x
   where x ->> 'status' = 'ONLINE'
   order by x ->> 'deviceCode'
   limit 1;
  if v_online is not null then
    raise exception using errcode = 'P0001',
      message = format('Scale %s of room %s is online: the weight is captured from it, never keyed by hand (DI-30, PR-20). [EBMR-EXE-074]', v_online, new.room_code);
  end if;
  v_balance := case when jsonb_typeof(v_entry -> 'balance') = 'string' then v_entry ->> 'balance' end;
  if v_balance is distinct from 'MANUAL'
     and not exists (select 1 from iam.device d
                      where d.code = v_balance and d.device_class = 'INSTRUMENT' and d.status = 'ACTIVE' and d.room_code = new.room_code) then
    raise exception using errcode = 'P0001',
      message = format('A weight keyed by hand names balance %s, which is not an active instrument of room %s; it names MANUAL or the balance of the room that was read (DI-20, DI-30). [EBMR-EXE-074]',
                       coalesce(v_entry ->> 'balance', '(none)'), new.room_code);
  end if;
  return new;
end
$$;

create trigger ac_tab_manual_weighing before insert on recipe.execution_command
  for each row execute function tab.manual_weighing_check();

-- ---------------------------------------------------------------------------------------------
-- 2. Heartbeats take the room lock (0250's function, with the lock added after the gateway key is known)
-- ---------------------------------------------------------------------------------------------

-- Heartbeat (INTEGRATION command, INTERFACE.WRITE): the instruments' connection states. A serial that is not the
-- registered one counts as SERIAL_MISMATCH whatever the gateway says, and raises an alert once per occurrence.
-- Reconciliation by counts (DI-31): a gateway that holds more acknowledged readings than this server raises an alarm
-- (at most once a minute); the answer carries the server's head, so the gateway sends them again. Before it writes, it
-- locks each room of the instruments it reports on (in room order), so it waits for a hand-keyed weighing of that room
-- being recorded (tab.manual_weighing_check) and is never interleaved with its check.
create or replace function tab.record_heartbeat(p_heartbeat jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key   tab.gateway_key%rowtype;
  v_bind  tab.gateway_instrument%rowtype;
  v_prev  text;
  v_state text;
  v_room  text;
  d       jsonb;
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
  if (p_heartbeat #>> '{journal,ackedSeq}') ~ '^[0-9]{1,18}$'
     and (p_heartbeat #>> '{journal,ackedSeq}')::bigint > (tab.chain_head(v_key.id) ->> 'seq')::bigint
     and not exists (select 1 from tab.device_alarm where code = 'EBMR-DEV-070' and gateway_code = v_key.gateway_code
                                                    and raised_at > clock_timestamp() - interval '1 minute') then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-070', v_key.gateway_code, null, null, (v_actor ->> 'session_id')::uuid,
      format('DI-31: the gateway counts %s acknowledged readings, the server holds %s; the gateway must send the missing readings again',
             p_heartbeat #>> '{journal,ackedSeq}', tab.chain_head(v_key.id) ->> 'seq'),
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
    if v_state not in ('CONNECTING', 'ONLINE', 'OFFLINE', 'SERIAL_MISMATCH') then
      v_state := 'OFFLINE';
    end if;
    if v_state = 'ONLINE' and (d ->> 'serial') is distinct from v_bind.expected_serial then
      v_state := 'SERIAL_MISMATCH';
    end if;
    select state into v_prev from tab.instrument_heartbeat where instrument_device_id = v_bind.instrument_device_id;
    if v_state = 'SERIAL_MISMATCH' and v_prev is distinct from 'SERIAL_MISMATCH' then
      perform tab.raise_device_alarm('SERIAL_MISMATCH', 'EBMR-DEV-048', v_key.gateway_code, v_bind.device_code, null,
        (v_actor ->> 'session_id')::uuid,
        format('DI-20: %s answers with serial %s, not the registered %s; it is refused until the registry or the instrument is corrected',
               v_bind.device_code, coalesce(d ->> 'serial', '(none)'), v_bind.expected_serial), d);
      perform iam.raise_alert('UNREGISTERED_DEVICE', 'HIGH', null, null, v_bind.instrument_device_id, null, (v_actor ->> 'session_id')::uuid,
        jsonb_build_object('reason', 'SERIAL_MISMATCH', 'device_code', v_bind.device_code, 'expected_serial', v_bind.expected_serial,
                           'reported_serial', d ->> 'serial', 'gateway', v_key.gateway_code));
    end if;
    insert into tab.instrument_heartbeat (instrument_device_id, gateway_key_id, state, serial, reported_at)
    values (v_bind.instrument_device_id, v_key.id, v_state, d ->> 'serial', clock_timestamp())
    on conflict (instrument_device_id) do update
      set gateway_key_id = excluded.gateway_key_id, state = excluded.state, serial = excluded.serial, reported_at = excluded.reported_at;
  end loop;
  return jsonb_build_object('serverTimeUs', platform.epoch_micros(clock_timestamp())::text, 'head', tab.chain_head(v_key.id));
end
$$;

revoke all on function tab.manual_weighing_check() from public;

reset role;
